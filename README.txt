StreamMulti
===========

StreamMulti (live at streammulti.live) is a personal multistream control deck
for watching several Twitch channels in one browser window. This fork plays
Twitch HLS streams directly via Streamlink and hls.js instead of using the
official video embed.

Channels are encoded in the URL:

    http://localhost:6543/gamesdonequick/anotherchannel

The code is free to use. This repository is an independent fork and is not
intended to be contributed back to the original MultiTwitch project.


Current features
----------------

Streams and playback:

* Direct HLS playback without the official Twitch video embed.
* Adaptive stream quality based on each tile's rendered device-pixel height.
* Add and remove channels without leaving the page; the URL stays in sync.
* Drag a stream over another tile to swap their positions.
* Select one stream as the audio source by clicking its video.
* Shift-click additional streams to mix their audio with independent volume.
* Master volume and mute controls, persisted in local browser storage. The
  first-run default is 70% and muted.
* Per-stream pause and resume controls.
* Per-stream jump-to-live controls for correcting multi-stream drift.
* Optional latency synchronization (experimental) that aligns streams to the
  slowest live feed, with persisted extra-buffer and synced-tolerance settings.
  May briefly desync after the tab is hidden, then re-aligns on return.
* Playback recovery when Chromium suspends background video, plus a distinct
  "Stream offline" state when Twitch confirms a failed channel is offline.
* Hover overlays for stream title, channel name, and game metadata.
* Touch-friendly tap-to-reveal tile controls.

Layouts:

* Grid: equally sized streams optimized for the available area.
* 1 Main: one primary stream with remaining streams fitted beside and below it.
* 2 Wide: two full-width primary streams side by side, with remaining streams
  below.
* 2 Stack: two vertically stacked primary streams with remaining streams fitted
  beside and below them.
* Adjustable main-stream sizing where the selected layout supports it. Main
  streams never become smaller than secondary streams.
* Layout, main sizing, and active audio source persist locally across refreshes.
* Theater mode with optional chat and an Escape shortcut.
* Keyboard controls for audio selection, mute, fullscreen, and picture-in-picture.
* Named lineup presets stored locally and loaded without a page refresh.

Chat and Twitch integration:

* Twitch chat tabs for every loaded channel.
* Draggable chat width, persisted locally, with a compact theater-mode size.
* Popup-based Twitch OAuth that leaves playing streams uninterrupted.
* Filterable followed-channel list with live and already-added states.
* Optional desktop notifications when followed channels go live.
* Automatic Stream Together discovery through Twitch's unofficial GraphQL API.
  The panel starts collapsed and glows when collaborators are detected; opening
  it acknowledges and clears the glow. Streams are never added automatically;
  already-loaded collaborators are marked as added.
* A "Feedback" button under the title opens a small form that emails feedback
  to the maintainer via Resend; the underlying address is never shown to the
  visitor (see "Feedback form" under Deployment).

Stream Together depends on an undocumented Twitch endpoint used by twitch.tv.
It is deliberately treated as a best-effort personal-use feature and may break
if Twitch changes its private API.


Local development
-----------------

Python 3.10 is the production baseline. On Windows PowerShell:

    py -3.10 -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
    .\.venv\Scripts\python.exe -m pip install -e . --no-deps
    .\.venv\Scripts\pserve.exe development.ini

Open http://localhost:6543 after the server starts.

Docker is the closest match to production:

    docker build -t multitwitch-local .
    docker run --rm --name multitwitch-local --env-file multistream.env `
      -e TWITCH_REDIRECT_URI=http://localhost:6543/auth/twitch/callback `
      -e TWITCH_SECURE_COOKIES=0 -p 6543:6543 `
      -v multitwitch-local-data:/app/data multitwitch-local

Create multistream.env first as described below, or omit `--env-file
multistream.env` when testing without Twitch OAuth.

The app works without Twitch OAuth. Direct streams, layouts, audio controls,
chat, and theater mode remain available; followed channels and authenticated
metadata require a Twitch connection.


Twitch configuration
--------------------

Register a Twitch application with this exact local OAuth redirect URL:

    http://localhost:6543/auth/twitch/callback

Twitch requires the configured callback and the application's redirect URI to
match exactly, including hostname, port, scheme, and path.

Copy multistream.env.example to a local multistream.env and configure:

    TWITCH_CLIENT_ID
    TWITCH_CLIENT_SECRET

The app also accepts these optional settings through the ini file or environment:

    TWITCH_REDIRECT_URI
    TWITCH_SESSION_DB
    TWITCH_SECURE_COOKIES

The feedback form (see "Feedback form" under Deployment) needs its own two
variables, also in multistream.env -- the form just shows "not configured"
locally if you skip them:

    RESEND_API_KEY
    FEEDBACK_TO

The real multistream.env contains credentials and is intentionally ignored by
Git. Commit multistream.env.example only.


Automated checks
----------------

Run the repository checks locally with:

    .\.venv\Scripts\python.exe -m unittest discover -s tests -v
    .\.venv\Scripts\python.exe -m compileall -q multitwitch runapp.py
    node --check multitwitch/static/js/multitwitch.js
    node --test tests/*.test.js
    docker compose -f deploy/docker-compose.yml config -q

The GitHub test workflow runs the Python and JavaScript unit suites, syntax
checks, and Compose validation on pushes and pull requests. Direct Twitch
playback, OAuth, browser autoplay/background suspension, chat embeds, and Stream
Together still require browser-level smoke testing because they depend on Twitch
and browser media policy.


Deployment: streammulti.live
----------------------------

The production deployment is an independent Compose stack on the shared edge
network, behind the VPS Caddy instance. Twitch OAuth sessions are stored in
SQLite on a named volume. Litestream replication to Backblaze B2 is enabled
when all five LITESTREAM_* variables are present. The VPS-side stack, the
data volume, and the GHCR image all keep the internal "multistream"/
"multitwitch" naming -- only the public domain and on-page branding changed.

The same container answers on two public domains (see deploy/Caddyfile):
streammulti.live is production, and multistream.robertmckinnon.au is kept
running as a dev/staging site (e.g. for testing Twitch OAuth or the HLS
proxy against a real deployed domain instead of localhost). No
TWITCH_REDIRECT_URI is pinned in docker-compose.yml -- it's derived per-
request from whichever domain the visitor used (multitwitch/__init__.py
trusts Caddy's X-Forwarded-Proto/-Host; runapp.py tells Waitress to trust
that hop since the container is never reachable except through Caddy).

Deployment artifacts:

    Dockerfile                  Python 3.10 image with Streamlink and Litestream
    docker/entrypoint.sh        Restores/replicates SQLite, then starts Waitress
    litestream.yml              Backblaze B2 replication configuration
    deploy/docker-compose.yml   Production service, volume, env, and networks
    deploy/Caddyfile            Shared-Caddy reverse proxy blocks (both domains)
    multistream.env.example     VPS environment template (real file mode 600)
    .github/workflows/deploy.yml  GHCR build and VPS deployment workflow

The app exposes GET /healthz for container health checks.

One-time infrastructure setup:

1. Point both the streammulti.live and multistream.robertmckinnon.au DNS
   records at the VPS.
2. Configure DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY, and optionally DEPLOY_PORT
   as GitHub repository secrets.
3. Create /etc/multistream.env on the VPS from multistream.env.example and set
   its permissions to 600.
4. Register BOTH of these production Twitch redirect URLs on the same Twitch
   app (the Twitch Developer Console allows multiple redirect URLs per app):

       https://streammulti.live/auth/twitch/callback
       https://multistream.robertmckinnon.au/auth/twitch/callback

5. Create the shared Docker edge network if it does not already exist:

       docker network create edge

Every push to master builds and publishes the image, updates the production
Compose stack, validates Caddy, and reloads the shared proxy. Pushes to master
should therefore be treated as production deployments.

Feedback form
~~~~~~~~~~~~~

The "Feedback" button (multitwitch/views/feedback.py, route POST
/api/feedback) sends via Resend's HTTP API. Set in /etc/multistream.env:

    RESEND_API_KEY   Same Resend account/API key used by other tools is fine
                      (the robertmckinnon.au domain must be sending-verified).
    FEEDBACK_TO       Where submissions are delivered. Required -- there is
                      no default, so feedback silently 503s until this is set.
    FEEDBACK_FROM     Optional; defaults to
                      "StreamMulti Feedback <feedback@robertmckinnon.au>".

The visitor's optional email (if they leave one) is set as Reply-To, not
From, so replying in your inbox goes straight to them. feedback@robertmckinnon.au
itself is never shown in the page or in any API response -- only used as the
From address server-side. A simple per-IP cooldown (30s) and a 4000-character
cap guard against trivial abuse; there's no CAPTCHA.

Production operations
~~~~~~~~~~~~~~~~~~~~~

Litestream 0.5 may repeatedly log messages similar to:

    timeout waiting for db initialization ... database may have corrupted
    local state or blocked transactions; try removing -litestream directory

These warnings were observed while the application and ``/healthz`` remained
healthy, so they do not by themselves mean that the session database is
unavailable. They do mean that Litestream compaction or replication health has
not been established and should be investigated separately from application
health. Check the container logs and confirm current snapshots in the B2
``multistream`` replica before relying on it for recovery.

Do not follow Litestream's suggestion to remove its local ``-litestream`` state
without first stopping the service, copying the named volume, and verifying the
remote replica. The same volume contains ``multistream.sqlite3``, which stores
Twitch OAuth sessions.

The current 1 GB VPS also has a persistent 2 GB ``/swapfile`` with
``vm.swappiness=10``. This prevents Docker image pulls from pushing the host
into memory-reclaim thrashing during deployment.


Known limitations
-----------------

* Chromium may suspend or destroy muted background media players when the
  window is occluded. The app attempts recovery when it becomes active again,
  but browser behavior can still vary by device and browser version.
* Stream Together uses an unofficial GraphQL endpoint and is inherently fragile.
* Twitch chat remains an official iframe embed even though video playback does
  not use the official player embed.
