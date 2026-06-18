MultiTwitch
===========

MultiTwitch is a personal multistream control deck for watching several Twitch
channels in one browser window. This fork plays Twitch HLS streams directly via
Streamlink and hls.js instead of using the official video embed.

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


Deployment: multistream.robertmckinnon.au
-----------------------------------------

The production deployment is an independent Compose stack on the shared edge
network, behind the VPS Caddy instance. Twitch OAuth sessions are stored in
SQLite on a named volume. Litestream replication to Backblaze B2 is enabled
when all five LITESTREAM_* variables are present.

Deployment artifacts:

    Dockerfile                  Python 3.10 image with Streamlink and Litestream
    docker/entrypoint.sh        Restores/replicates SQLite, then starts Waitress
    litestream.yml              Backblaze B2 replication configuration
    deploy/docker-compose.yml   Production service, volume, env, and networks
    deploy/Caddyfile            Shared-Caddy reverse proxy block
    multistream.env.example     VPS environment template (real file mode 600)
    .github/workflows/deploy.yml  GHCR build and VPS deployment workflow

The app exposes GET /healthz for container health checks.

One-time infrastructure setup:

1. Point the multistream DNS record at the VPS.
2. Configure DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY, and optionally DEPLOY_PORT
   as GitHub repository secrets.
3. Create /etc/multistream.env on the VPS from multistream.env.example and set
   its permissions to 600.
4. Register this production Twitch redirect URL:

       https://multistream.robertmckinnon.au/auth/twitch/callback

5. Create the shared Docker edge network if it does not already exist:

       docker network create edge

Every push to master builds and publishes the image, updates the production
Compose stack, validates Caddy, and reloads the shared proxy. Pushes to master
should therefore be treated as production deployments.


Known limitations
-----------------

* Chromium may suspend or destroy muted background media players when the
  window is occluded. The app attempts recovery when it becomes active again,
  but browser behavior can still vary by device and browser version.
* Stream Together uses an unofficial GraphQL endpoint and is inherently fragile.
* Twitch chat remains an official iframe embed even though video playback does
  not use the official player embed.
