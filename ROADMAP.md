# MultiTwitch Roadmap

Planned work for the personal multistream control deck. Items are grouped by
priority. Decisions captured here reflect deliberate scoping choices — see
"Out of scope" for things considered and dropped.

## Planned features

### 1. Adaptive stream quality by rendered pixels
Pick each stream's Twitch quality automatically from the tile's *actual* pixel
size rather than always requesting `best`.

- Measure each tile's rendered width/height (× `devicePixelRatio`) and choose the
  smallest Twitch rendition that still meets or exceeds it.
- Only re-evaluate **after a tile has not been resized for 10 seconds**, so
  dragging layouts / the main-size slider doesn't thrash the players.
- Reload the HLS source for a tile only when its target rendition actually
  changes.
- Rationale: if a user drives a 4K monitor we can assume they can handle the
  load; conversely, small grid tiles should pull cheaper renditions to save CPU
  and bandwidth.
- Touch points: the direct-stream endpoint currently hard-codes
  `quality: "best"` (`load_direct_stream` in `multitwitch.js`); server side must
  accept and honour a requested quality/height.

### 2. Persist view state to localStorage
Stop throwing away the user's layout on every refresh. Persist:

- Layout mode (currently hard-reset to `grid` on load).
- Main-size fraction per layout.
- Active audio stream (restore only if still in the lineup).
- "Keep chat in theater" toggle (optional).

Tile order already round-trips through the URL, so it is **not** duplicated here.
Decision: localStorage, **not** URL encoding.

### 3. Per-stream audio / independent volume
Move beyond the single active-audio model — allow hearing more than one stream
at once and/or a per-tile volume, so e.g. game audio and commentary can be mixed.

### 4. Expanded keyboard shortcuts
Currently only `T` (theater) and `Esc`. Add:

- Number keys `1`–`9` to set the audio source / promote a tile to main.
- Per-tile fullscreen (Fullscreen API).
- Picture-in-Picture for the active stream (follows the user to another tab).

## Backlog (nice-to-have)

- Saved channel presets — named groups loaded with one click.
- Go-live desktop notifications for followed channels.
- Touch support — tap-to-reveal overlays and controls (they are hover-only today,
  so titles and pause are unreachable on touch devices).
- Per-tile "jump to live edge" resync to correct multi-stream drift.

## Bugs

- **Connect triggers a full-page reload.** `connect_twitch()` navigates the whole
  page through the OAuth redirect (`auth_start` → Twitch → `auth_callback` →
  `HTTPFound(return_to)`), reloading every stream just to authenticate. Fix by
  running OAuth in a popup window: `auth_start`/`auth_callback` gain a popup mode
  that `postMessage`s the opener and closes, so the main page and its loaded
  streams stay intact while the user authenticates.

## Out of scope (considered, dropped)

- Surfacing extra Twitch metadata (viewer count, uptime) on tiles — not wanted.
- "Load all live follows" button — could open 300+ streams at once; too dangerous.
- Encoding view state in the URL — localStorage is preferred instead.

## Status

- [ ] 1. Adaptive stream quality by rendered pixels
- [x] 2. Persist view state to localStorage — layout mode, per-layout main size,
  and audio source restore on refresh
- [ ] 3. Per-stream audio / independent volume
- [ ] 4. Expanded keyboard shortcuts
- [ ] Bug: Connect full-page reload (popup OAuth)
