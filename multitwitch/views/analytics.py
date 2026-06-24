import calendar
import json
import os
import re
import threading
import time

from pyramid.response import Response

MAX_EVENT_NAME_LENGTH = 40
MAX_FIELD_LENGTH = 80
MAX_EVENTS_PER_WINDOW = 120
RATE_LIMIT_SECONDS = 60
DEFAULT_RETENTION_DAYS = 30
ALLOWED_EVENTS = {
    'client_error',
    'page_view',
    'stream_added',
    'stream_removed',
    'layout_changed',
    'theater_toggled',
    'chat_toggled',
    'feedback_opened',
    'twitch_connect_clicked',
    'followed_channels_loaded',
    'notifications_toggled',
}
ALLOWED_FIELDS = {
    'event',
    'stream_count',
    'layout',
    'darkmode',
    'theater',
    'chat_hidden',
    'viewport',
    'screen',
    'source',
    'enabled',
    'area',
    'kind',
    'detail',
}

_WRITE_LOCK = threading.Lock()
_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_BUCKETS = {}
_CLEANUP_DATES = set()


def record(request):
    if not _allow_event(_client_key(request)):
        return Response(status=204)

    event = _sanitize_event(_request_payload(request))
    if not event:
        return Response(status=204)

    log_file = _analytics_log_file(request)
    if log_file:
        today = _today()
        dated_log_file = _dated_log_file(log_file, today)
        _append_event(dated_log_file, _with_server_fields(request, event))
        _cleanup_old_logs(log_file, _retention_days(request), today)

    return Response(status=204)


def _request_payload(request):
    try:
        body = getattr(request, 'json_body', None)
        if isinstance(body, dict):
            return body
    except ValueError:
        pass

    body = getattr(request, 'body', b'')
    if isinstance(body, str):
        body = body.encode('utf-8')
    if body:
        try:
            data = json.loads(body.decode('utf-8'))
            if isinstance(data, dict):
                return data
        except (UnicodeDecodeError, ValueError):
            return {}

    params = getattr(request, 'params', None)
    if isinstance(params, dict):
        return dict(params)
    return {}


def _sanitize_event(payload):
    name = _clean_string(payload.get('event'), MAX_EVENT_NAME_LENGTH)
    if name not in ALLOWED_EVENTS:
        return None

    event = {'event': name}
    for key in ALLOWED_FIELDS:
        if key == 'event' or key not in payload:
            continue
        value = payload.get(key)
        if isinstance(value, bool):
            event[key] = value
        elif isinstance(value, int):
            event[key] = max(0, min(value, 99))
        else:
            cleaned = _clean_string(value, MAX_FIELD_LENGTH)
            if cleaned:
                event[key] = cleaned
    return event


def _clean_string(value, max_length):
    if value is None:
        return ''
    value = str(value).strip()
    if not value:
        return ''
    return value[:max_length]


def _with_server_fields(request, event):
    enriched = {
        'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'host': _clean_string(getattr(request, 'host', ''), MAX_FIELD_LENGTH),
    }
    enriched.update(event)
    return enriched


def _append_event(log_file, event):
    directory = os.path.dirname(log_file)
    if directory:
        os.makedirs(directory, exist_ok=True)
    line = json.dumps(event, sort_keys=True, separators=(',', ':')) + '\n'
    with _WRITE_LOCK:
        with open(log_file, 'a', encoding='utf-8') as f:
            f.write(line)


def _dated_log_file(log_file, today):
    directory = os.path.dirname(log_file)
    filename = os.path.basename(log_file)
    stem, ext = os.path.splitext(filename)
    return os.path.join(directory, '%s-%s%s' % (stem, today, ext))


def _cleanup_old_logs(log_file, retention_days, today):
    if retention_days <= 0:
        return
    cleanup_key = log_file + ':' + today
    with _WRITE_LOCK:
        if cleanup_key in _CLEANUP_DATES:
            return
        _CLEANUP_DATES.add(cleanup_key)

        directory = os.path.dirname(log_file) or '.'
        if not os.path.isdir(directory):
            return

        filename = os.path.basename(log_file)
        stem, ext = os.path.splitext(filename)
        pattern = re.compile(r'^%s-(\d{4}-\d{2}-\d{2})%s$' % (re.escape(stem), re.escape(ext)))
        cutoff = _date_to_days(today) - retention_days
        for candidate in os.listdir(directory):
            match = pattern.match(candidate)
            if not match:
                continue
            if _date_to_days(match.group(1)) < cutoff:
                try:
                    os.remove(os.path.join(directory, candidate))
                except OSError:
                    pass


def _analytics_log_file(request):
    settings = getattr(getattr(request, 'registry', None), 'settings', {}) or {}
    return (
        os.environ.get('ANALYTICS_LOG_FILE', '').strip()
        or str(settings.get('analytics.log_file', '')).strip()
    )


def _retention_days(request):
    settings = getattr(getattr(request, 'registry', None), 'settings', {}) or {}
    value = (
        os.environ.get('ANALYTICS_RETENTION_DAYS', '').strip()
        or str(settings.get('analytics.retention_days', '')).strip()
    )
    if not value:
        return DEFAULT_RETENTION_DAYS
    try:
        return max(0, min(int(value), 365))
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def _today():
    return time.strftime('%Y-%m-%d', time.gmtime())


def _date_to_days(value):
    try:
        parsed = time.strptime(value, '%Y-%m-%d')
    except ValueError:
        return 0
    return int(calendar.timegm(parsed) // 86400)


def _client_key(request):
    headers = getattr(request, 'headers', {}) or {}
    forwarded = (headers.get('X-Forwarded-For') or '').split(',')[0].strip()
    return forwarded or getattr(request, 'remote_addr', '') or 'unknown'


def _allow_event(key):
    now = time.monotonic()
    with _RATE_LIMIT_LOCK:
        bucket = [seen for seen in _RATE_LIMIT_BUCKETS.get(key, []) if now - seen < RATE_LIMIT_SECONDS]
        if len(bucket) >= MAX_EVENTS_PER_WINDOW:
            _RATE_LIMIT_BUCKETS[key] = bucket
            return False
        bucket.append(now)
        _RATE_LIMIT_BUCKETS[key] = bucket
        return True
