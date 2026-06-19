# MultiTwitch (Pyramid + waitress) image with Litestream-wrapped startup.
# Mirrors the robertmckinnon.au hosting handbook's Python equivalent of
# templates/Dockerfile.example. Litestream replicates the SQLite session DB to B2
# only when the five LITESTREAM_* vars are present (see docker/entrypoint.sh).

FROM python:3.10-slim
ARG LITESTREAM_VERSION=0.5.12
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=6543 \
    TWITCH_SESSION_DB=/app/data/multistream.sqlite3

# Litestream + the CA bundle it needs to reach B2 over TLS:
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /tmp/litestream.deb "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.deb" \
  && dpkg -i /tmp/litestream.deb \
  && rm -rf /tmp/litestream.deb /var/lib/apt/lists/* \
  && useradd --system --create-home --shell /usr/sbin/nologin app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .
# Register the egg entry point (egg:multitwitch) without re-resolving deps:
RUN pip install -e . --no-deps \
  && sed -i 's/\r$//' ./docker/entrypoint.sh \
  && chmod +x ./docker/entrypoint.sh \
  && mkdir -p /app/data \
  && chown -R app:app /app

USER app
EXPOSE 6543
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:6543/healthz').status==200 else 1)"
ENTRYPOINT ["./docker/entrypoint.sh"]
