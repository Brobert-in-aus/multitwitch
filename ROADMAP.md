# StreamMulti Roadmap

This fork is a personal multistream control deck. The core feature set is now
implemented; this file tracks remaining verification and maintenance work.

## Verification before and after deployment

- Verify Twitch OAuth popup login and token refresh through the production URL.
- Verify go-live desktop notifications across a full offline -> live transition.
- Test tap-to-reveal controls on a physical touch device.
- Exercise background-player recovery in current Edge and Chrome releases.
- Confirm Litestream restore and replication against the production B2 bucket.

## Maintenance backlog

- Add browser-level integration tests for controls that do not require Twitch.
- Expand JavaScript unit coverage around presets, audio mixing, and quality
  selection as those features evolve.
- Monitor the unofficial Stream Together GraphQL query for Twitch schema changes.
- Revisit Chromium background media handling when upstream behavior changes.

## Deliberately out of scope

- Loading every live followed channel at once.
- Encoding view state in the URL; localStorage is preferred.
- Additional tile metadata such as viewer count and uptime.
