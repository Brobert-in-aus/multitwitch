# Obsoleting Stream Sync: always-on convergence to a shared near-live point

**Status:** All three phases implemented. Phase 3 additions: ⟳ / snap-to-live
seeks to the shared wall (edge−0.5 only as the no-PDT fallback), and a startup
bias (`bias_startup_toward_wall`) raises a fresh instance's `liveSyncDuration`
on LEVEL_LOADED so streams joining a slower group start on the wall instead of
ahead of it. Not done: the optional merge of the latency-label interval into
the convergence tick (cosmetic; both run at 1s).

## Goal

Delete the experimental "Stream sync" feature (button, sliders, measuring states,
toggle) and replace it with nothing the user has to think about: every stream,
all the time, converges to the same short distance behind live and stays there.
With one stream that means "hold ~4s behind the edge"; with five streams it means
"all five show the same real-world instant, ~4s behind the slowest channel's
ingest". Same controller, no modes, no toggle.

Working assumption (stated by the product owner): viewers have the bandwidth and
latency to hold every stream near live. The controller therefore optimises for
staying at the edge and treats falling behind as the exceptional case.

## Why the current design can't just be "always on"

The existing sync loop (`run_latency_sync` and friends in
`multitwitch/static/js/multitwitch.js`) has three structural problems that would
make an always-on version drift away from live rather than toward it:

1. **It syncs on the wrong quantity.** It equalises "seconds behind my own live
   edge" per stream. Two channels' live edges differ in wall-clock terms by each
   streamer's capture→ingest→transcode delay, so equal latency is not the same
   moment. The signal itself (`hls.latency` / edge+age) also sawtooths by a full
   ~2s segment as playlists reload, which forced the EMA smoothing, the wide
   tolerance, and the 2s loop interval that aliases with the segment period.
2. **The target is frozen at startup and only ratchets up.** Each player's
   `sync_natural_latency` is seeded from its *first* sample — an arbitrary phase
   of the 2s sawtooth, captured at the moment the stream is most likely to be
   transiently behind. The group target is the max of those frozen values and
   nothing ever pulls it back down; recoveries can re-seed it higher mid-session.
3. **Correction authority is too timid for edge-holding.** Rate nudges cap at
   6%, so closing 1.5s takes ~25–50s. Holding a group at the live edge needs a
   controller that can catch up quickly and invisibly.

## The replacement: PDT-anchored convergence controller

### Signal

Twitch media playlists carry `#EXT-X-PROGRAM-DATE-TIME` on every regular
segment, and **both proxies pass it through untouched** (verified: the rewriters
in `multitwitch/views/direct.py` `_rewrite_playlist` and
`cmd/hlsproxy/main.go` only touch URIs and `#EXT-X-TWITCH-PREFETCH` tags).
hls.js therefore exposes:

- `hls.playingDate` — server-stamped wall-clock time of the current playhead,
  interpolated within the fragment. **Smooth: no sawtooth, no smoothing EMA, no
  aliasing.** This kills the entire `sync_smoothed_latency` apparatus.
- Fragment `programDateTime` + duration on the last fragment of
  `hls.latestLevelDetails`, plus `details.age` → the channel's **live-edge PDT**:
  the wall-clock moment currently coming off the wire for that channel.

Prefetch-promoted segments (we synthesise `#EXTINF` for them in the proxies, no
PDT tag) are handled by hls.js's standard extrapolation: PDT of the last tagged
fragment plus accumulated durations. Accurate to well under the deadband.

All cross-stream comparisons happen in PDT space (Twitch ingest clocks), so the
client's clock never enters the math and client clock skew is irrelevant.

### Shared target

Every tick, over the **healthy** players (playing, not `startup_pending`, not
`recovering`, not `manual_paused`, engine `hls`):

```
edge_pdt_i   = last fragment PDT + duration + details.age      (per player)
target_pdt   = min_i(edge_pdt_i) − HOLDBACK
```

- `HOLDBACK = 4s` — matches the existing `liveSyncDuration: 4` (≈2 segments of
  cushion). One constant, one meaning: "how far behind the slowest channel's
  ingest we sit".
- The `min` picks the channel whose pipeline is furthest behind real time
  (e.g. an fMP4 "Enhanced Broadcasting" channel, which gets no prefetch
  promotion and so has an older edge). You cannot sync closer to live than
  that stream can deliver, so this is by construction the closest-to-live
  shared instant.
- **Straggler exclusion:** a player whose `edge_pdt` trails the group max by
  more than `STRAGGLER_LIMIT` (10s) is dropped from the `min` — a stalled
  playlist must not drag the whole wall back. The straggler keeps steering
  toward the shared target and rejoins the derivation once its edge recovers.
- No frozen state anywhere: the target is recomputed from live playlist data
  every tick, so it tracks reality in both directions and a bad startup moment
  costs nothing.
- With a single stream the same formula degenerates to "hold HOLDBACK behind my
  own edge" — no special case, which is what lets the *feature* disappear.

### Correction

Per healthy player, `error = (playingDate − target_pdt) / 1000` seconds
(positive = behind the wall):

| |error| | action |
|---|---|
| < 0.3s (`DEADBAND`) | nothing; `playbackRate = 1` |
| 0.3s … 4s | proportional rate nudge, **asymmetric**: up to **+15%** when behind (catching up toward live is near-imperceptible with browser pitch correction), at most **−5%** when ahead (slowing is what viewers notice on the audible stream) |
| ≥ 4s (`SEEK_THRESHOLD`) | hard seek: `video.currentTime += error`, clamped to the seekable range, with a per-player cooldown **longer than the loop interval** (e.g. 3s — the old 1500ms cooldown was a no-op against the 2s loop) |

The deadband can be this tight — versus the old 1.0s default tolerance — because
the PDT signal has no per-segment sawtooth. It comfortably covers residual
cross-channel ingest-timestamp skew.

Keep the correction function **pure** (`(playing_pdt, target_pdt, seekable
bounds) → {seek_to, playback_rate}`), same as today's
`latency_sync_correction`, so the node test suite covers it without a DOM.

### Loop

One `setInterval` at **1000ms**, started unconditionally from
`initialize_stream_players` (replacing `initialize_latency_sync`). No enabled
flag, no aliasing concern (smooth signal), and it can share the tick with
`update_stream_latency_labels` (also currently 1s) so there's one clock, not
two.

### Startup alignment

Keep `liveSyncDuration: 4` equal to `HOLDBACK`. A fresh attach then lands within
cross-channel ingest skew of the shared target, and the rate controller trims
the remainder invisibly — no visible "attach, then jump" double-seek, and no
need to thread a `startPosition` through attach.

### Fallbacks / graceful degradation

- **No PDT on a fragment set** (rare on Twitch): fall back per-stream to
  steering `measure_player_latency(player) → HOLDBACK`. The stream holds near
  live individually; it just can't wall-clock align. Keep
  `measure_player_latency` for this and for the latency labels.
- **Native engine (iOS Safari, no MSE):** no latency/seek control exists —
  skip steering entirely, exactly as today. Desktop is always hls.js already
  (Chromium 142 native-demuxer policy in `desired_player_engine`).
- **Hidden tab:** controller no-ops while `!page_active()` (browsers pause
  muted video and throttle timers). `resume_all_after_inactive` snaps paused
  players **to the shared target** (see cleanups) and the next tick settles
  everyone — replaces both of today's branches on `latency_sync_enabled`.

## Implementation order

Each phase leaves the app shippable.

### Phase 1 — controller in, old loop still present but inert

1. New JS: `player_edge_pdt(player)`, `player_playing_pdt(player)`,
   `compute_convergence_target(players)` (min-edge + straggler exclusion),
   `convergence_correction(...)` (pure), `run_convergence()` (the tick).
2. Start the 1s tick in `initialize_stream_players`.
3. Add a debug kill switch — `?nosync=1` (or a localStorage flag) checked once
   at init — so a misbehaving controller in production can be bypassed without
   a deploy. Remove it once the feature has soaked.
4. Node tests for the pure functions: target derivation (min-edge picks slowest
   ingest; straggler excluded; single stream degenerates to self-hold),
   correction curve (deadband, asymmetry caps, seek threshold, seekable
   clamping), PDT→media-time translation.

### Phase 2 — delete the old feature

**JS (`multitwitch/static/js/multitwitch.js`):**
- Constants and state: `LATENCY_SYNC_DELAY_STORAGE_KEY`,
  `LATENCY_SYNC_TOLERANCE_STORAGE_KEY`, `LATENCY_SYNC_INTERVAL`,
  `LATENCY_SYNC_HARD_THRESHOLD` (already dead code — `max(0.75, tolerance+1.0)`
  never selects it), `LATENCY_SYNC_SOFT_THRESHOLD`,
  `LATENCY_SYNC_MIN_TOLERANCE`, `latency_sync_enabled`,
  `latency_sync_extra_delay`, `latency_sync_tolerance`,
  `latency_sync_base_latency`, `latency_sync_timer`.
- Functions: `load/clamp/set_latency_sync_delay`,
  `load/clamp/set_latency_sync_tolerance`, `initialize_latency_sync`,
  `calculate_latency_sync_target`, `latency_sync_correction`,
  `collect_latency_sync_players`, `toggle_latency_sync`,
  `disable_latency_sync`, `run_latency_sync`, `update_latency_sync_ui`.
- Player fields: `sync_natural_latency`, `sync_smoothed_latency` (replaced by
  nothing — no per-player sync state survives except `last_sync_seek_at`,
  renamed for the new cooldown).
- The sync EMA block in the `timeupdate` handler (the "sawtooths by ~1 segment"
  comment and the `sync_smoothed_latency` update) — obsolete with PDT.
- `run_latency_sync` trigger sites: the `playing` handler,
  `complete_stream_startup`, `resume_all_after_inactive`.
- `reconcile_player_engines`: its only callers are the sync toggle paths.
  Engine policy is static now (hls.js wherever it runs) — delete it.
- One-time `localStorage.removeItem` for the two dead keys, or just let them
  rot; they're harmless.

**Template (`multitwitch/templates/web/home.tmpl`):**
- The whole `latency_sync_panel` section (the `{% if show_stream_sync %}`
  block: header, Experimental tag, state chip, button, both sliders).
- The `initialize_latency_sync()` call in the boot script.
- Help popup: replace any stream-sync explanation with one line — "streams
  automatically stay aligned a few seconds behind live".

**Server (`multitwitch/views/web.py`):**
- `STREAM_SYNC_HIDDEN_ON`, the `show_stream_sync` template variable, and the
  comment block above them (it already says "Remove this once the feature is
  ready to ship everywhere again" — this is that removal, in the other
  direction).

**CSS (`multitwitch/static/css/multitwitch.css`):** the latency-sync panel /
slider / state-chip rules.

**Tests:** drop the `latency_sync_*` cases in `tests/layout.test.js` (target,
clamps, tolerance, correction) — superseded by the Phase 1 tests. Drop the
`show_stream_sync` assertions in `tests/test_views.py` if present.

**Docs:** rewrite README.txt's sync bullet ("Optional latency
synchronization (experimental)…") to describe the automatic behaviour incl. the
hidden-tab note; CHANGES.txt entry.

### Phase 3 — repurpose the leftovers that referenced sync

- **`sync_to_live` (per-tile ⟳ button):** it currently disables sync and snaps
  to the raw edge. With the controller always on, snapping to the raw edge
  starts a fight the controller wins two ticks later. Redefine the button as
  "re-align now": `snap_player_to_live` seeks to the *shared target* (media
  time = `currentTime + (target_pdt − playingDate)/1000`) instead of
  `live_edge − 0.5`, keeping the `hls.startLoad(-1)` loader restart. Same
  user intent — "this tile is stuck/behind, fix it" — no mode interaction.
- **`resume_all_after_inactive`:** delete both `latency_sync_enabled` branches;
  always snap paused players to the shared target and let the next tick settle.
- **Latency labels (`update_stream_latency_labels`):** keep, unchanged — still
  useful, and independent of the controller. Optionally drive both from the
  same 1s tick.

## Improvements from the earlier review, and where they land

| Finding | Resolution |
|---|---|
| Natural latency frozen at an arbitrary sawtooth phase | Gone — no frozen state; PDT signal has no sawtooth |
| Target only ratchets up, anchored to startup transients | Gone — target recomputed from live edges every tick |
| Equal latency ≠ same wall-clock moment | Core of the new design (PDT anchoring) |
| 3–6% catch-up too timid | Asymmetric +15% / −5% |
| 2s loop aliases with 2s segments; EMA lag causes oscillation | 1s loop on a smooth signal; EMA deleted |
| Attach-then-seek double jump on startup | `liveSyncDuration == HOLDBACK`, controller trims the rest |
| `LATENCY_SYNC_HARD_THRESHOLD` dead code | Deleted with the old loop |
| 1500ms seek cooldown < 2000ms interval (no-op) | New cooldown (3s) > loop interval (1s) |

## Deliberately dropped

- **Extra-delay slider (+0…30s):** its only real use was spoiler buffering. If
  demand reappears, it's a one-line constant added to `HOLDBACK` behind a
  single setting — do not carry the UI forward speculatively.
- **Tolerance slider:** tolerance becomes the internal `DEADBAND`. Users were
  tuning around the sawtooth; the sawtooth is gone.

## Edge cases and risks

- **Ad breaks / discontinuities:** Twitch keeps PDT continuous across ad pods;
  `playingDate` stays valid across `EXT-X-DISCONTINUITY`. Hard seeks across a
  discontinuity are ordinary hls.js seeks.
- **fMP4 (Enhanced Broadcasting) channels:** no prefetch promotion (by design,
  see `_rewrite_playlist`), so their edge PDT runs ~1–2 segments older. They
  will typically *be* the `min` and set the wall for the group — correct: the
  group cannot show a moment that channel hasn't delivered yet.
- **Cross-channel ingest timestamp skew:** PDTs are stamped by Twitch ingest,
  not streamer PCs; observed skew is well under the 0.3s deadband. If a channel
  ever presents pathological PDT (hours off), its `edge_pdt` will trip the
  straggler limit relative to the others and it simply self-holds at HOLDBACK
  via the no-PDT fallback path — worth a defensive `Math.abs(edge_skew) >
  STRAGGLER_LIMIT` check in target derivation.
- **All streams stall together** (viewer network blip): every edge freezes,
  target freezes, everyone holds — recovery is symmetric. No action needed.

## Verification checklist (per phase, in the browser)

1. Two channels covering the same live event: hover latency labels read ~4–6s;
   `playingDate` delta between tiles < 0.5s within a minute of load.
2. Add a third channel mid-session: it joins within one seek + a few ticks,
   with no visible jump on the existing tiles.
3. Hide the tab 2 minutes, return: tiles realign within ~10s, no reload churn.
4. Kill one stream's network (devtools throttling) 30s, restore: the other
   tiles never move; the throttled one catches up at ≤1.15×, seeking only if
   > 4s behind.
5. One fMP4 channel in the mix: group sits slightly further back, stays synced.
6. `?nosync=1`: controller inert, playback otherwise normal.
7. iOS Safari (or UA-forced native): no rate/seek activity, no errors.
