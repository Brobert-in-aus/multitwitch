from multitwitch.views.web import WebView
from multitwitch.views import direct
from multitwitch.views import analytics
from multitwitch.views import feedback
from multitwitch.views import twitch

def routes(config):
    static_cache_max_age = int(config.registry.settings.get('static.cache_max_age', 3600))
    config.add_static_view('static', 'static', cache_max_age=static_cache_max_age)

    config.add_route('healthz', '/healthz')
    config.add_view(WebView.healthz, route_name='healthz')

    config.add_route('favicon', '/favicon.ico')
    config.add_view(WebView.favicon, route_name='favicon')

    config.add_route('twitch_auth_start', '/auth/twitch/start')
    config.add_view(twitch.auth_start, route_name='twitch_auth_start')
    config.add_route('twitch_auth_callback', '/auth/twitch/callback')
    config.add_view(twitch.auth_callback, route_name='twitch_auth_callback')
    config.add_route('twitch_auth_logout', '/auth/twitch/logout')
    config.add_view(twitch.auth_logout, route_name='twitch_auth_logout', request_method='POST')
    config.add_route('twitch_me', '/api/twitch/me')
    config.add_view(twitch.me, route_name='twitch_me')
    config.add_route('twitch_followed_channels', '/api/twitch/follows')
    config.add_view(twitch.followed_channels, route_name='twitch_followed_channels')
    config.add_route('twitch_followed_streams', '/api/twitch/followed-streams')
    config.add_view(twitch.followed_streams, route_name='twitch_followed_streams')
    config.add_route('twitch_streams', '/api/twitch/streams')
    config.add_view(twitch.streams, route_name='twitch_streams')
    config.add_route('twitch_public_streams', '/api/twitch/public-streams')
    config.add_view(twitch.public_streams, route_name='twitch_public_streams')
    config.add_route('twitch_live_status', '/api/twitch/live-status/{channel}')
    config.add_view(twitch.live_status, route_name='twitch_live_status')
    config.add_route('twitch_users', '/api/twitch/users')
    config.add_view(twitch.users, route_name='twitch_users')
    config.add_route('twitch_guest_star_session', '/api/twitch/guest-star')
    config.add_view(twitch.guest_star_session, route_name='twitch_guest_star_session')
    config.add_route('twitch_stream_together', '/api/twitch/stream-together')
    config.add_view(twitch.stream_together, route_name='twitch_stream_together')

    config.add_route('direct_stream_url', '/api/direct-stream/{channel}')
    config.add_view(direct.stream_url, route_name='direct_stream_url')

    config.add_route('hls_proxy', '/api/hls-proxy')
    config.add_view(direct.hls_proxy, route_name='hls_proxy')

    config.add_route('feedback', '/api/feedback')
    config.add_view(feedback.submit, route_name='feedback', request_method='POST')

    config.add_route('analytics', '/api/events')
    config.add_view(analytics.record, route_name='analytics', request_method='POST')

    config.add_route('root', '*streams')
    config.add_view(WebView.home, route_name='root')
