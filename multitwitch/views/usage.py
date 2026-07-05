"""Usage dashboard: a small, login-gated web view over the analytics logs.

Reuses multitwitch/lib/usage_report.py (shared with scripts/usage_report.py) to
aggregate the same daily JSONL files the app writes. Access is guarded by a
single-admin password login that mirrors the workout tracker's conventions (a
hashed password kept out of the repo, an httpOnly/SameSite=Lax/Secure cookie,
30-day expiry, rate-limited attempts) but stays stdlib-only.

    GET  /admin/usage     -> HTML dashboard (redirects to /admin/login if not authed)
    GET  /admin/login     -> login form
    POST /admin/login     -> verify password, set session cookie, redirect
    POST /admin/logout    -> clear session cookie
    GET  /api/usage-data  -> JSON summary consumed by the dashboard's JS (cookie-authed)

The dashboard is disabled (returns 404) whenever no password hash is configured,
so it never leaks data by default.
"""

import hashlib
import hmac
import os
import threading
import time
from http.cookies import SimpleCookie

import simplejson as json
from pyramid.httpexceptions import HTTPFound, HTTPSeeOther
from pyramid.response import Response

from multitwitch.lib.session import env
from multitwitch.lib.passwords import verify_password
from multitwitch.lib.usage_report import (
    expand_paths,
    iter_events,
    summarize,
    to_jsonable,
)

COOKIE_NAME = 'sm_usage'
SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 days, matching the workout tracker
MAX_RANGE_LENGTH = 10  # 'YYYY-MM-DD'

# Simple in-memory brute-force throttle on the login endpoint (per client key),
# in the spirit of feedback.py / analytics.py. The password is a strong hash, so
# this is belt-and-suspenders, not the primary defence.
LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_ATTEMPTS = 8
_LOGIN_LOCK = threading.Lock()
_LOGIN_ATTEMPTS = {}


# --- Endpoints -------------------------------------------------------------

def dashboard(request):
    if _disabled(request):
        return _not_found()
    if not _authenticated(request):
        return HTTPFound(location='/admin/login')

    tmpl = env.get_template('web/usage.tmpl')
    return Response(tmpl.render({'project': 'StreamMulti'}), content_type='text/html')


def login(request):
    if _disabled(request):
        return _not_found()

    if request.method == 'GET':
        if _authenticated(request):
            return HTTPFound(location='/admin/usage')
        return _render_login(request)

    # POST
    if not _allow_login_attempt(_client_key(request)):
        return _render_login(request, error='Too many attempts. Please wait a few minutes.', status=429)

    password = request.params.get('password') or ''
    if verify_password(password, _password_hash(request)):
        response = HTTPSeeOther(location='/admin/usage')
        _set_session_cookie(request, response)
        return response

    return _render_login(request, error='Incorrect password.', status=401)


def logout(request):
    response = HTTPSeeOther(location='/admin/login')
    response.delete_cookie(COOKIE_NAME, path='/')
    return response


def data(request):
    if _disabled(request):
        return _not_found()
    if not _authenticated(request):
        return Response('Unauthorized', status=401, content_type='text/plain')

    since = _clean_date(request.params.get('since'))
    until = _clean_date(request.params.get('until'))

    log_file = _analytics_log_file(request)
    files = expand_paths([log_file]) if log_file else []
    summary = summarize(iter_events(files, since=since, until=until))

    payload = to_jsonable(summary)
    payload['configured'] = bool(log_file)
    payload['file_count'] = len(files)
    return Response(
        body=json.dumps(payload).encode('utf-8'),
        content_type='application/json',
        charset='utf-8',
        # Analytics data should never be cached by a proxy or the browser.
        headers={'Cache-Control': 'no-store'},
    )


# --- Auth helpers ----------------------------------------------------------

def _password_hash(request):
    settings = getattr(getattr(request, 'registry', None), 'settings', {}) or {}
    return (
        os.environ.get('ANALYTICS_DASHBOARD_PASSWORD_HASH', '').strip()
        or str(settings.get('analytics.dashboard_password_hash', '')).strip()
    )


def _disabled(request):
    return not _password_hash(request)


def _signing_key(request):
    # Derive the cookie-signing key from the password hash so it needs no separate
    # secret and so changing the password automatically invalidates old sessions.
    return hashlib.sha256(('sm-usage-v1:' + _password_hash(request)).encode('utf-8')).digest()


def _sign(request, expiry):
    return hmac.new(_signing_key(request), str(expiry).encode('ascii'), hashlib.sha256).hexdigest()


def _set_session_cookie(request, response):
    expiry = int(time.time()) + SESSION_TTL_SECONDS
    value = '%d.%s' % (expiry, _sign(request, expiry))
    response.set_cookie(
        COOKIE_NAME,
        value,
        max_age=SESSION_TTL_SECONDS,
        path='/',
        httponly=True,
        secure=_secure_cookies(request),
        samesite='Lax',
    )


def _authenticated(request):
    value = _cookie_value(request, COOKIE_NAME)
    if not value or '.' not in value:
        return False
    expiry_str, _, signature = value.partition('.')
    try:
        expiry = int(expiry_str)
    except ValueError:
        return False
    if expiry < time.time():
        return False
    return hmac.compare_digest(_sign(request, expiry), signature)


def _cookie_value(request, name):
    header = (getattr(request, 'headers', {}) or {}).get('Cookie')
    if not header:
        return None
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return None
    return jar[name].value if name in jar else None


def _secure_cookies(request):
    # Behind Caddy the forwarded proto is trusted (see __init__), so this is https
    # in production and http for local dev, which is the behaviour we want.
    return getattr(request, 'scheme', 'http') == 'https'


def _client_key(request):
    headers = getattr(request, 'headers', {}) or {}
    forwarded = (headers.get('X-Forwarded-For') or '').split(',')[0].strip()
    return forwarded or getattr(request, 'remote_addr', '') or 'unknown'


def _allow_login_attempt(key):
    now = time.monotonic()
    with _LOGIN_LOCK:
        attempts = [t for t in _LOGIN_ATTEMPTS.get(key, []) if now - t < LOGIN_WINDOW_SECONDS]
        if len(attempts) >= LOGIN_MAX_ATTEMPTS:
            _LOGIN_ATTEMPTS[key] = attempts
            return False
        attempts.append(now)
        _LOGIN_ATTEMPTS[key] = attempts
        return True


# --- Rendering / misc ------------------------------------------------------

def _render_login(request, error=None, status=200):
    tmpl = env.get_template('web/usage_login.tmpl')
    body = tmpl.render({'project': 'StreamMulti', 'error': error})
    return Response(body, content_type='text/html', status=status)


def _not_found():
    return Response('Not found', status=404, content_type='text/plain')


def _clean_date(value):
    value = (value or '').strip()[:MAX_RANGE_LENGTH]
    # Only pass through well-formed dates; anything else is treated as absent so
    # a bad query param can't smuggle characters into the comparison.
    if len(value) == MAX_RANGE_LENGTH and value[4] == '-' and value[7] == '-':
        digits = value[:4] + value[5:7] + value[8:]
        if digits.isdigit():
            return value
    return None


def _analytics_log_file(request):
    settings = getattr(getattr(request, 'registry', None), 'settings', {}) or {}
    return (
        os.environ.get('ANALYTICS_LOG_FILE', '').strip()
        or str(settings.get('analytics.log_file', '')).strip()
    )
