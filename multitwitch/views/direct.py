import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlsplit
from urllib.request import Request, urlopen

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


PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl'
HLS_URI_ATTRIBUTE_RE = re.compile(r'URI="([^"]+)"')
PREFETCH_TAG = '#EXT-X-TWITCH-PREFETCH:'
EXTINF_RE = re.compile(r'^#EXTINF:([0-9]*\.?[0-9]+)')


def hls_proxy(request):
    """Proxy a Twitch HLS *playlist* so hls.js can fetch it same-origin.

    hls.js loads the playlist with a cross-origin JS request; Twitch's playlist
    host 403s those from non-Twitch origins. Fetching it server-side (no Origin
    header) succeeds, and the segment URIs inside stay absolute Twitch CDN links
    -- which DO allow CORS -- so the browser still pulls the heavy segment data
    directly. Only the small playlist text passes through here.
    """
    raw_url = request.params.get('url', '')
    if not raw_url:
        return _json_response({'error': 'Missing url parameter.'}, status=400)
    if not _is_allowed_hls_url(raw_url):
        return _json_response({'error': 'URL host is not allowed.'}, status=400)

    proxied = Request(raw_url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urlopen(proxied, timeout=10) as upstream:
            body = upstream.read().decode('utf-8', 'replace')
            final_url = upstream.geturl() if hasattr(upstream, 'geturl') else raw_url
    except HTTPError as exc:
        return _json_response({'error': 'Upstream returned %d.' % exc.code}, status=502)
    except URLError as exc:
        return _json_response({'error': str(exc.reason)}, status=502)
    if not _is_allowed_hls_url(final_url):
        return _json_response({'error': 'Upstream redirect host is not allowed.'}, status=502)

    response = Response(
        body=_rewrite_playlist(body, final_url).encode('utf-8'),
        content_type=PLAYLIST_CONTENT_TYPE,
        charset='UTF-8',
    )
    # Live playlists roll every few seconds -- never cache.
    response.headers['Cache-Control'] = 'no-store'
    return response


def _is_allowed_hls_url(url):
    # Allowlist Twitch hosts only: this endpoint fetches arbitrary URLs, so an
    # open allowlist would make it an SSRF/open proxy.
    parts = urlsplit(url)
    if parts.scheme != 'https':
        return False
    host = (parts.hostname or '').lower()
    return host == 'ttvnw.net' or host.endswith('.ttvnw.net')


def _hls_proxy_path(url):
    return '/api/hls-proxy?url=' + quote(url, safe='')


def _rewrite_hls_uri(uri, base_url, playlist=False):
    absolute = urljoin(base_url, uri)
    return _hls_proxy_path(absolute) if playlist else absolute


def _rewrite_playlist(body, base_url):
    # Keep every master/alternate playlist same-origin. Segments, keys and init
    # files remain direct Twitch CDN URLs, so their bandwidth bypasses us.
    lines = []
    next_uri_is_playlist = False
    last_segment_duration = None
    prefetch_promoted = False
    for line in body.split('\n'):
        stripped = line.strip()
        # Twitch advertises its true live edge -- the freshest one or two
        # segments -- via proprietary #EXT-X-TWITCH-PREFETCH tags. hls.js doesn't
        # understand that tag, so it would play the last regular segment and sit
        # several seconds further behind live than Twitch's own player. Promote
        # the FIRST prefetch URL to a normal #EXTINF segment so hls.js plays near
        # the edge, but drop the newest one: it may still be mid-write (short
        # read / 404), and staying a segment back leaves headroom to ride out
        # lag spikes without stalling. Costs ~1 segment (~2s) of latency.
        if stripped.startswith(PREFETCH_TAG):
            prefetch_uri = stripped[len(PREFETCH_TAG):].strip()
            if prefetch_uri and not prefetch_promoted:
                duration = last_segment_duration if last_segment_duration is not None else 2.0
                lines.append('#EXTINF:%.3f,' % duration)
                lines.append(_rewrite_hls_uri(prefetch_uri, base_url, False))
                prefetch_promoted = True
            continue
        if stripped and not stripped.startswith('#'):
            lines.append(_rewrite_hls_uri(stripped, base_url, next_uri_is_playlist))
            next_uri_is_playlist = False
        else:
            extinf = EXTINF_RE.match(stripped)
            if extinf:
                last_segment_duration = float(extinf.group(1))
            tag_has_playlist_uri = stripped.startswith('#EXT-X-MEDIA:') \
                or stripped.startswith('#EXT-X-I-FRAME-STREAM-INF:')
            rewritten = HLS_URI_ATTRIBUTE_RE.sub(
                lambda match: 'URI="%s"' % _rewrite_hls_uri(
                    match.group(1), base_url, tag_has_playlist_uri,
                ),
                line,
            )
            lines.append(rewritten)
            next_uri_is_playlist = stripped.startswith('#EXT-X-STREAM-INF:')
    return '\n'.join(lines)


def _json_response(data, status=200):
    return Response(
        text=json.dumps(data),
        content_type='application/json',
        status=status,
    )
