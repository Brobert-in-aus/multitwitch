from pyramid.config import Configurator

from .config import routes


def _trust_forwarded_headers(app):
    # The backend is never reachable except through Caddy (no `ports:` in
    # compose, and runapp.py tells Waitress to trust it as the proxy), so
    # trusting X-Forwarded-Proto/-Host unconditionally here is safe -- nothing
    # outside Caddy can reach this process to spoof them. Without this,
    # request.scheme/request.host_url reflect the plain-HTTP hop from Caddy to
    # this container, not the public https://<domain> the visitor actually
    # used, which breaks the Twitch OAuth redirect_uri (twitch.py derives it
    # from request.host_url when TWITCH_REDIRECT_URI isn't pinned) -- needed
    # so the same app can serve multiple public domains correctly.
    def wrapped(environ, start_response):
        forwarded_proto = environ.get('HTTP_X_FORWARDED_PROTO')
        if forwarded_proto:
            environ['wsgi.url_scheme'] = forwarded_proto.split(',')[0].strip()
        forwarded_host = environ.get('HTTP_X_FORWARDED_HOST')
        if forwarded_host:
            environ['HTTP_HOST'] = forwarded_host.split(',')[0].strip()
        return app(environ, start_response)
    return wrapped


def main(global_config, **settings):
    """ This function returns a Pyramid WSGI application.
    """
    config = Configurator(settings=settings)
    config.include(routes)
    return _trust_forwarded_headers(config.make_wsgi_app())

