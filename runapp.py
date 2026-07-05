import os

from paste.deploy import loadapp
from waitress import serve

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app = loadapp('config:production.ini', relative_to='.')

    # Waitress strips X-Forwarded-* headers by default unless the connecting
    # peer is an explicitly trusted proxy. The container is never reachable
    # except through Caddy (no `ports:` in compose), so '*' (trust any peer)
    # is safe here -- without it, multitwitch._trust_forwarded_headers never
    # sees these headers and request.host_url falls back to the internal
    # Caddy->container hop instead of the public domain the visitor used.
    serve(
        app,
        host='0.0.0.0',
        port=port,
        trusted_proxy='*',
        # x-forwarded-for is trusted too so request.remote_addr is the real
        # client IP (used only transiently for rate-limiting and country
        # geolocation in analytics -- the IP itself is never stored).
        trusted_proxy_headers={'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-for'},
        clear_untrusted_proxy_headers=True,
    )
