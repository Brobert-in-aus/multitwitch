import json
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pyramid.response import Response

RESEND_API_URL = 'https://api.resend.com/emails'
DEFAULT_FROM = 'StreamMulti Feedback <feedback@robertmckinnon.au>'
SUBJECT = 'StreamMulti feedback'
MAX_MESSAGE_LENGTH = 4000
MAX_EMAIL_LENGTH = 200
RATE_LIMIT_SECONDS = 30
RATE_LIMIT_MAX_ENTRIES = 1000

_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_LAST_SEEN = {}


def submit(request):
    api_key = os.environ.get('RESEND_API_KEY', '').strip()
    to_address = os.environ.get('FEEDBACK_TO', '').strip()
    if not api_key or not to_address:
        return _json_response({'error': 'Feedback is not configured.'}, status=503)

    message = (request.params.get('message') or '').strip()
    if not message:
        return _json_response({'error': 'Please enter a message.'}, status=400)
    if len(message) > MAX_MESSAGE_LENGTH:
        return _json_response({'error': 'Message is too long.'}, status=400)

    reply_to = (request.params.get('email') or '').strip()
    if reply_to and (len(reply_to) > MAX_EMAIL_LENGTH or '@' not in reply_to):
        return _json_response({'error': "That email address doesn't look right."}, status=400)

    if not _allow_submission(_client_key(request)):
        return _json_response({'error': 'Please wait a bit before sending more feedback.'}, status=429)

    from_address = os.environ.get('FEEDBACK_FROM', '').strip() or DEFAULT_FROM
    # Put the submitter's address in the visible body too: reply_to alone is an
    # invisible header that most clients don't show, and the mail forwarder can
    # rewrite it, so the address would otherwise be lost.
    sender_line = 'From: ' + reply_to if reply_to else 'From: (no email provided)'
    body_text = sender_line + '\n\n' + message
    payload = {
        'from': from_address,
        'to': [to_address],
        'subject': SUBJECT,
        'text': body_text,
    }
    if reply_to:
        payload['reply_to'] = reply_to

    try:
        _send_via_resend(api_key, payload)
    except (HTTPError, URLError, ValueError):
        return _json_response(
            {'error': 'Could not send feedback right now. Please try again later.'}, status=502
        )

    return _json_response({'ok': True})


def _send_via_resend(api_key, payload):
    body = json.dumps(payload).encode('utf-8')
    request = Request(RESEND_API_URL, data=body, method='POST')
    request.add_header('Authorization', 'Bearer ' + api_key)
    request.add_header('Content-Type', 'application/json')
    # Resend sits behind Cloudflare, which blocks the default Python-urllib
    # User-Agent (HTTP 403, error 1010). Send an explicit one.
    request.add_header('User-Agent', 'StreamMulti/1.0 (+https://streammulti.live)')
    with urlopen(request, timeout=10) as response:
        response.read()


def _client_key(request):
    forwarded = (request.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
    return forwarded or getattr(request, 'remote_addr', '') or 'unknown'


def _allow_submission(key):
    now = time.monotonic()
    with _RATE_LIMIT_LOCK:
        expired = [k for k, seen in _RATE_LIMIT_LAST_SEEN.items() if now - seen > RATE_LIMIT_SECONDS]
        for expired_key in expired:
            del _RATE_LIMIT_LAST_SEEN[expired_key]

        last_seen = _RATE_LIMIT_LAST_SEEN.get(key)
        if last_seen is not None and now - last_seen < RATE_LIMIT_SECONDS:
            return False

        if len(_RATE_LIMIT_LAST_SEEN) >= RATE_LIMIT_MAX_ENTRIES:
            oldest_key = min(_RATE_LIMIT_LAST_SEEN, key=_RATE_LIMIT_LAST_SEEN.get)
            del _RATE_LIMIT_LAST_SEEN[oldest_key]

        _RATE_LIMIT_LAST_SEEN[key] = now
        return True


def _json_response(data, status=200):
    return Response(
        body=json.dumps(data).encode('utf-8'),
        status=status,
        content_type='application/json; charset=UTF-8',
    )
