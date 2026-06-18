import re
import threading
import time

import simplejson as json
from pyramid.response import Response

from multitwitch.views.twitch import channel_is_live

try:
    from streamlink import Streamlink
except Exception:
    Streamlink = None


CHANNEL_RE = re.compile(r'^[A-Za-z0-9_]{1,25}$')
STREAM_CACHE_TTL = 60
STREAM_CACHE_FORCE_REFRESH_AGE = 5
STREAM_CACHE_MAX_ENTRIES = 256
STREAM_CACHE = {}
STREAM_CACHE_LOCK = threading.Lock()


def stream_url(request):
    channel = request.matchdict.get('channel', '').lower()
    quality = request.params.get('quality', 'best')
    if not CHANNEL_RE.match(channel):
        return _json_response({'error': 'Invalid Twitch channel.'}, status=400)
    if not CHANNEL_RE.match(quality):
        return _json_response({'error': 'Invalid stream quality.'}, status=400)
    if Streamlink is None:
        return _json_response({'error': 'Streamlink is not installed.'}, status=503)

    cache_key = (channel, quality)
    force_refresh = request.params.get('refresh') == '1'
    now = time.time()
    with STREAM_CACHE_LOCK:
        expired_keys = [
            key for key, entry in STREAM_CACHE.items()
            if entry['expires_at'] <= now
        ]
        for key in expired_keys:
            del STREAM_CACHE[key]
        cached = STREAM_CACHE.get(cache_key)
        cache_age = now - cached.get('resolved_at', 0) if cached else None
        refresh_allowed = force_refresh and cache_age is not None and cache_age >= STREAM_CACHE_FORCE_REFRESH_AGE
        if cached and cached['expires_at'] > now and not refresh_allowed:
            return _json_response(cached['data'])

    try:
        data = _resolve_stream_url(channel, quality)
    except Exception as exc:
        try:
            if not channel_is_live(channel):
                return _json_response({'error': 'Stream offline.'}, status=404)
        except Exception:
            pass
        return _json_response({'error': str(exc)}, status=502)

    with STREAM_CACHE_LOCK:
        if len(STREAM_CACHE) >= STREAM_CACHE_MAX_ENTRIES:
            oldest_key = min(
                STREAM_CACHE,
                key=lambda key: STREAM_CACHE[key]['expires_at'],
            )
            del STREAM_CACHE[oldest_key]
        STREAM_CACHE[cache_key] = {
            'data': data,
            'expires_at': now + STREAM_CACHE_TTL,
            'resolved_at': now,
        }
    return _json_response(data)


def _resolve_stream_url(channel, quality):
    session = Streamlink()
    session.set_option('http-timeout', 15.0)
    streams = session.streams('https://www.twitch.tv/' + channel)
    if not streams:
        raise RuntimeError(channel + ' is offline or no playable streams were found.')

    selected_quality = quality if quality in streams else 'best'
    stream = streams.get(selected_quality)
    if stream is None:
        selected_quality, stream = next(iter(streams.items()))

    url = getattr(stream, 'url', None)
    if not url and hasattr(stream, 'to_url'):
        url = stream.to_url()
    if not url:
        raise RuntimeError('Could not resolve a browser-playable stream URL.')

    qualities = sorted([
        name for name in streams.keys()
        if name not in ('worst', 'best') and not name.endswith('_alt')
    ])
    return {
        'channel': channel,
        'quality': selected_quality,
        'qualities': qualities,
        'url': url,
    }


def _json_response(data, status=200):
    return Response(
        text=json.dumps(data),
        content_type='application/json',
        status=status,
    )
