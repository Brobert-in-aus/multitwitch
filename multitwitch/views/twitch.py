import json
import os
import re
import secrets
import sqlite3
import time
from http.cookies import SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pyramid.httpexceptions import HTTPFound
from pyramid.response import Response


COOKIE_NAME = 'multitwitch_session'
TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2/authorize'
TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
TWITCH_API_URL = 'https://api.twitch.tv/helix/'
TWITCH_GQL_URL = 'https://gql.twitch.tv/gql'
TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
TWITCH_SCOPES = 'user:read:follows channel:read:guest_star moderator:read:guest_star'
CURRENT_USER_ID = object()
CHANNEL_RE = re.compile(r'^[A-Za-z0-9_]{1,25}$')
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ENV_FILE_PATHS = (
    '/etc/multistream.env',
    os.path.join(PROJECT_ROOT, 'multistream.env'),
)
ENV_FILE_VALUES = None
GUEST_STAR_BATCH_COLLABORATION_QUERY = '''
query GuestStarBatchCollaborationQuery(
  $options: GuestStarChannelCollaborationOptions,
  $canDropInFlagEnabled: Boolean!,
  $openCallingFlagEnabled: Boolean!
) {
  guestStarChannelCollaboration(options: $options) {
    id
    session {
      id
      host {
        login
        displayName
      }
      guests {
        id
        slotID
        user {
          login
          displayName
          stream {
            id
            viewersCount
            collaborationViewersCount
          }
        }
      }
    }
    canDropIn @include(if: $canDropInFlagEnabled)
    canJoinStatus @include(if: $openCallingFlagEnabled)
    isFavorite
  }
  guestStarCollaborationStatuses(options: $options) @include(if: $openCallingFlagEnabled) {
    shouldRefetch
    shouldSubscribeToUpdates
    channelCollabs {
      id
      session {
        id
        host {
          login
          displayName
        }
        guests {
          id
          slotID
          user {
            login
            displayName
            stream {
              id
              viewersCount
              collaborationViewersCount
            }
          }
        }
      }
      canJoinStatus
      isFavorite
    }
  }
}
'''
CHANNEL_LIVE_STATUS_QUERY = '''
query ChannelLiveStatus($login: String!) {
  user(login: $login) {
    stream {
      id
    }
  }
}
'''


def auth_start(request):
    settings = _twitch_settings(request)
    if not settings['configured']:
        return _json_response({'configured': False, 'error': 'Twitch OAuth is not configured.'}, status=503)

    session_id, session = _ensure_session(request)
    session['state'] = secrets.token_urlsafe(24)
    session['return_to'] = _safe_return_to(request.params.get('return_to'))
    # Popup flow: the callback closes the popup and pings the opener instead of
    # navigating the main page (which would reload every stream).
    session['popup'] = bool(request.params.get('popup'))
    _save_session(request, session_id, session)

    auth_params = {
        'client_id': settings['client_id'],
        'redirect_uri': settings['redirect_uri'],
        'response_type': 'code',
        'scope': TWITCH_SCOPES,
        'state': session['state'],
    }
    response = HTTPFound(TWITCH_AUTH_URL + '?' + urlencode(auth_params))
    _set_session_cookie(request, response, session_id)
    return response


def auth_callback(request):
    settings = _twitch_settings(request)
    session_id, session = _ensure_session(request)

    if not settings['configured']:
        return _auth_complete(request, session_id, session)
    if request.params.get('state') != session.get('state'):
        session['auth_error'] = 'Twitch returned an invalid state.'
        return _auth_complete(request, session_id, session)
    if request.params.get('error'):
        session['auth_error'] = request.params.get('error_description') or request.params.get('error')
        return _auth_complete(request, session_id, session)

    try:
        token_data = _token_request({
            'client_id': settings['client_id'],
            'client_secret': settings['client_secret'],
            'code': request.params.get('code', ''),
            'grant_type': 'authorization_code',
            'redirect_uri': settings['redirect_uri'],
        })
    except TwitchRequestError as exc:
        session['auth_error'] = exc.message
        return _auth_complete(request, session_id, session)

    session['token'] = token_data
    session['token']['expires_at'] = int(time.time()) + int(token_data.get('expires_in', 0))
    session.pop('state', None)
    session.pop('auth_error', None)
    return _auth_complete(request, session_id, session)


# Terminal step of the OAuth callback for both success and error: persists the
# session, then either closes the popup (signalling the opener to refresh its
# Twitch state in place) or redirects the page back for the non-popup flow.
def _auth_complete(request, session_id, session):
    return_to = session.get('return_to', '/')
    is_popup = bool(session.pop('popup', None))
    _save_session(request, session_id, session)
    response = _popup_close_response() if is_popup else HTTPFound(return_to)
    _set_session_cookie(request, response, session_id)
    return response


def _popup_close_response():
    html = (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Twitch</title></head>'
        '<body><script>(function(){'
        'try{if(window.opener){window.opener.postMessage("multitwitch-twitch-auth", window.location.origin);}}catch(e){}'
        'window.close();'
        '})();</script><p>Twitch authentication complete. You can close this window.</p>'
        '</body></html>'
    )
    return Response(body=html.encode('utf-8'), content_type='text/html; charset=UTF-8')


def auth_logout(request):
    session_id = _session_id_from_request(request)
    if session_id:
        _delete_session(request, session_id)
    response = _json_response({'connected': False})
    response.delete_cookie(COOKIE_NAME)
    return response


def me(request):
    settings = _twitch_settings(request)
    if not settings['configured']:
        return _json_response({
            'configured': False,
            'connected': False,
            'message': 'Set twitch.client_id, twitch.client_secret, and twitch.redirect_uri.',
        })

    session = _session_from_request(request)
    if session and session.get('auth_error') and 'token' not in session:
        message = session.pop('auth_error')
        _save_existing_session(request, session)
        return _json_response({
            'configured': True,
            'connected': False,
            'message': message,
        })

    if not session or 'token' not in session:
        return _json_response({
            'configured': True,
            'connected': False,
            'message': 'Connect Twitch to load followed channels.',
        })

    try:
        user = _validate_token(session['token']['access_token'])
    except TwitchRequestError:
        session.pop('token', None)
        _save_existing_session(request, session)
        return _json_response({
            'configured': True,
            'connected': False,
            'message': 'Twitch session expired. Connect again.',
        })

    session['user'] = user
    _save_existing_session(request, session)
    return _json_response({
        'configured': True,
        'connected': True,
        'login': user.get('login'),
        'user_id': user.get('user_id'),
    })


def followed_channels(request):
    return _proxy_twitch(request, 'channels/followed', {
        'user_id': CURRENT_USER_ID,
        'first': request.params.get('first', '100'),
        'after': request.params.get('after'),
    })


def followed_streams(request):
    return _proxy_twitch(request, 'streams/followed', {
        'user_id': CURRENT_USER_ID,
        'first': request.params.get('first', '100'),
        'after': request.params.get('after'),
    })


def streams(request):
    return _proxy_twitch(request, 'streams', {
        'user_login': request.params.getall('user_login') or request.params.get('user_login'),
        'first': request.params.get('first', '100'),
    })


def channel_is_live(login):
    data = _gql_request({
        'operationName': 'ChannelLiveStatus',
        'query': CHANNEL_LIVE_STATUS_QUERY,
        'variables': {'login': login},
    })
    user = (data.get('data') or {}).get('user')
    return bool(user and user.get('stream'))


def live_status(request):
    login = (request.matchdict.get('channel') or '').strip().lower()
    if not CHANNEL_RE.match(login):
        return _json_response({'error': 'Invalid Twitch channel.'}, status=400)
    try:
        return _json_response({'channel': login, 'live': channel_is_live(login)})
    except TwitchRequestError as exc:
        return _json_response({'error': exc.message}, status=exc.status)


def users(request):
    return _proxy_twitch(request, 'users', {'login': request.params.get('login')})


def guest_star_session(request):
    return _proxy_twitch(request, 'guest_star/session', {
        'broadcaster_id': request.params.get('broadcaster_id'),
        'moderator_id': CURRENT_USER_ID,
    })


def stream_together(request):
    login = (request.params.get('login') or '').strip().lower()
    if not CHANNEL_RE.match(login):
        return _json_response({'error': 'Invalid Twitch login.'}, status=400)
    try:
        user_data = _gql_request({
            'operationName': 'UserByLogin',
            'variables': {'login': login},
            'query': (
                'query UserByLogin($login: String!) { '
                'user(login: $login) { id login displayName } '
                '}'
            ),
        })
        user = (user_data.get('data') or {}).get('user')
        if not user:
            return _json_response({'error': 'Could not find ' + login + '.'}, status=404)

        collaboration_data = _gql_request({
            'operationName': 'GuestStarBatchCollaborationQuery',
            'variables': {
                'options': {'channelIDs': [user['id']]},
                'canDropInFlagEnabled': True,
                'openCallingFlagEnabled': True,
            },
            'query': GUEST_STAR_BATCH_COLLABORATION_QUERY,
        })
    except TwitchRequestError as exc:
        return _json_response({'error': exc.message}, status=exc.status)

    collabs = ((collaboration_data.get('data') or {}).get('guestStarChannelCollaboration') or [])
    collab = collabs[0] if collabs else None
    session = collab.get('session') if collab else None
    guests = session.get('guests') if session else []
    streamers = []
    seen = set()
    for slot in guests or []:
        slot_user = slot.get('user') or {}
        slot_login = slot_user.get('login')
        stream = slot_user.get('stream') or {}
        if not slot_login or slot_login == 'SCREENSHARE' or not stream.get('id'):
            continue
        key = slot_login.lower()
        if key in seen:
            continue
        seen.add(key)
        streamers.append({
            'login': key,
            'display_name': slot_user.get('displayName') or slot_login,
            'viewers': stream.get('viewersCount'),
            'collaboration_viewers': stream.get('collaborationViewersCount'),
        })

    return _json_response({
        'login': login,
        'channel_id': user['id'],
        'session_id': session.get('id') if session else None,
        'host': session.get('host') if session else None,
        'streamers': streamers,
        'raw_available': bool(session),
    })


def _proxy_twitch(request, path, params):
    session = _require_authenticated_session(request)
    if isinstance(session, Response):
        return session

    settings = _twitch_settings(request)
    current_user_id = session.get('user', {}).get('user_id')
    params = {
        key: current_user_id if value is CURRENT_USER_ID else value
        for key, value in params.items()
    }
    params = _flatten_proxy_params({key: value for key, value in params.items() if value})
    try:
        data = _api_request(path, params, session['token']['access_token'], settings['client_id'])
        return _json_response(data)
    except TwitchRequestError as exc:
        return _json_response({'error': exc.message}, status=exc.status)


def _current_user_id(request):
    session = _session_from_request(request) or {}
    user = session.get('user') or {}
    return user.get('user_id')


def _flatten_proxy_params(params):
    pairs = []
    for key, value in params.items():
        if isinstance(value, (list, tuple)):
            pairs.extend((key, item) for item in value if item)
        else:
            pairs.append((key, value))
    return pairs


def _require_authenticated_session(request):
    settings = _twitch_settings(request)
    if not settings['configured']:
        return _json_response({'error': 'Twitch OAuth is not configured.'}, status=503)

    session = _session_from_request(request)
    if not session or 'token' not in session:
        return _json_response({'error': 'Not connected to Twitch.'}, status=401)

    if session['token'].get('expires_at', 0) < int(time.time()) + 60:
        if not _refresh_token(settings, session):
            session.pop('token', None)
            _save_existing_session(request, session)
            return _json_response({'error': 'Twitch session expired.'}, status=401)
        _save_existing_session(request, session)

    if 'user' not in session:
        try:
            session['user'] = _validate_token(session['token']['access_token'])
            _save_existing_session(request, session)
        except TwitchRequestError:
            session.pop('token', None)
            _save_existing_session(request, session)
            return _json_response({'error': 'Twitch session expired.'}, status=401)

    return session


def _refresh_token(settings, session):
    refresh_token = session.get('token', {}).get('refresh_token')
    if not refresh_token:
        return False
    try:
        token_data = _token_request({
            'client_id': settings['client_id'],
            'client_secret': settings['client_secret'],
            'grant_type': 'refresh_token',
            'refresh_token': refresh_token,
        })
    except TwitchRequestError:
        return False
    session['token'] = token_data
    session['token']['expires_at'] = int(time.time()) + int(token_data.get('expires_in', 0))
    session.pop('user', None)
    return True


def _token_request(params):
    body = urlencode(params).encode('utf-8')
    request = Request(TWITCH_TOKEN_URL, data=body, method='POST')
    request.add_header('Content-Type', 'application/x-www-form-urlencoded')
    return _request_json(request)


def _validate_token(access_token):
    request = Request(TWITCH_VALIDATE_URL)
    request.add_header('Authorization', 'OAuth ' + access_token)
    return _request_json(request)


def _api_request(path, params, access_token, client_id):
    request = Request(TWITCH_API_URL + path + '?' + urlencode(params))
    request.add_header('Authorization', 'Bearer ' + access_token)
    request.add_header('Client-Id', client_id)
    return _request_json(request)


def _gql_request(payload):
    body = json.dumps(payload).encode('utf-8')
    request = Request(TWITCH_GQL_URL, data=body, method='POST')
    request.add_header('Content-Type', 'application/json')
    request.add_header('Client-Id', TWITCH_WEB_CLIENT_ID)
    request.add_header('User-Agent', 'Mozilla/5.0')
    data = _request_json(request)
    errors = data.get('errors') or []
    if errors:
        message = errors[0].get('message') if isinstance(errors[0], dict) else str(errors[0])
        raise TwitchRequestError(502, message or 'Twitch GraphQL error.')
    return data


def _request_json(request):
    try:
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode('utf-8') or '{}')
    except HTTPError as exc:
        body = exc.read().decode('utf-8')
        try:
            data = json.loads(body)
            message = data.get('message') or data.get('error') or body
        except ValueError:
            message = body or exc.reason
        raise TwitchRequestError(exc.code, message)
    except URLError as exc:
        raise TwitchRequestError(502, str(exc.reason))


def _twitch_settings(request):
    settings = request.registry.settings
    client_id = _configured_value(settings, 'twitch.client_id', 'TWITCH_CLIENT_ID')
    client_secret = _configured_value(settings, 'twitch.client_secret', 'TWITCH_CLIENT_SECRET')
    redirect_uri = _configured_value(settings, 'twitch.redirect_uri', 'TWITCH_REDIRECT_URI')
    session_db = _configured_value(settings, 'twitch.session_db', 'TWITCH_SESSION_DB') or 'data/twitch_sessions.sqlite3'
    if not redirect_uri:
        redirect_uri = request.host_url + '/auth/twitch/callback'
    return {
        'client_id': client_id,
        'client_secret': client_secret,
        'redirect_uri': redirect_uri,
        'session_db': _absolute_path(session_db),
        'configured': bool(client_id and client_secret),
    }


def _ensure_session(request):
    session_id = _session_id_from_request(request)
    session = _load_session(request, session_id) if session_id else None
    if not session_id or session is None:
        session_id = secrets.token_urlsafe(32)
        session = {'id': session_id}
        _save_session(request, session_id, session)
    else:
        session['id'] = session_id
    return session_id, session


def _session_from_request(request):
    session_id = _session_id_from_request(request)
    if not session_id:
        return None
    session = _load_session(request, session_id)
    if session is not None:
        session['id'] = session_id
    return session


def _session_id_from_request(request):
    cookie_header = request.headers.get('Cookie')
    if not cookie_header:
        return None
    cookie = SimpleCookie()
    cookie.load(cookie_header)
    if COOKIE_NAME not in cookie:
        return None
    return cookie[COOKIE_NAME].value


def _set_session_cookie(request, response, session_id):
    response.set_cookie(
        COOKIE_NAME,
        session_id,
        httponly=True,
        secure=_secure_cookies(request),
        samesite='Lax',
    )


def _secure_cookies(request):
    setting = _configured_value(request.registry.settings, 'twitch.secure_cookies', 'TWITCH_SECURE_COOKIES')
    if setting:
        return setting.lower() in ('1', 'true', 'yes', 'on')
    return request.scheme == 'https'


def _configured_value(settings, key, env_name):
    value = settings.get(key, '').strip()
    if value:
        return value
    value = os.environ.get(env_name, '').strip()
    if value:
        return value
    return _env_file_values().get(env_name, '').strip()


def _env_file_values():
    global ENV_FILE_VALUES
    if ENV_FILE_VALUES is not None:
        return ENV_FILE_VALUES
    values = {}
    for env_path in ENV_FILE_PATHS:
        if not os.path.exists(env_path):
            continue
        with open(env_path, encoding='utf-8') as env_file:
            for line in env_file:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                values[key.strip().lstrip('\ufeff')] = value.strip().strip('"').strip("'")
    ENV_FILE_VALUES = values
    return ENV_FILE_VALUES


def _absolute_path(path):
    if os.path.isabs(path):
        return path
    return os.path.abspath(path)


def _session_connection(request):
    db_path = _twitch_settings(request)['session_db']
    db_dir = os.path.dirname(db_path)
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir)
    conn = sqlite3.connect(db_path)
    conn.execute(
        'CREATE TABLE IF NOT EXISTS twitch_sessions '
        '(id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    )
    return conn


def _load_session(request, session_id):
    if not session_id:
        return None
    with _session_connection(request) as conn:
        row = conn.execute(
            'SELECT data FROM twitch_sessions WHERE id = ?',
            (session_id,),
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except ValueError:
        return None


def _save_existing_session(request, session):
    session_id = session.get('id') or _session_id_from_request(request)
    if session_id:
        _save_session(request, session_id, session)


def _save_session(request, session_id, session):
    data = dict(session)
    data.pop('id', None)
    with _session_connection(request) as conn:
        conn.execute(
            'INSERT OR REPLACE INTO twitch_sessions (id, data, updated_at) VALUES (?, ?, ?)',
            (session_id, json.dumps(data), int(time.time())),
        )


def _delete_session(request, session_id):
    with _session_connection(request) as conn:
        conn.execute('DELETE FROM twitch_sessions WHERE id = ?', (session_id,))


def _safe_return_to(return_to):
    if not return_to or not return_to.startswith('/') or return_to.startswith('//'):
        return '/'
    return return_to


def _json_response(data, status=200):
    return Response(
        body=json.dumps(data).encode('utf-8'),
        status=status,
        content_type='application/json; charset=UTF-8',
    )


class TwitchRequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        Exception.__init__(self, message)
