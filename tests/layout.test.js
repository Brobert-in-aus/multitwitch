const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");


function loadApplication() {
    const values = new Map();
    const localStorage = {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
    const context = {
        clearTimeout,
        console,
        Date,
        localStorage,
        Math,
        setInterval() {},
        setTimeout,
        URL,
        window: {localStorage},
        document: {},
        $() {
            return {};
        }
    };
    vm.createContext(context);
    const source = fs.readFileSync(
        path.join(__dirname, "..", "multitwitch", "static", "js", "multitwitch.js"),
        "utf8"
    );
    vm.runInContext(source, context, {filename: "multitwitch.js"});
    return {context, localStorage};
}


test("fit_16_9 preserves aspect ratio inside width- and height-bound boxes", () => {
    const {context} = loadApplication();

    const widthBound = context.fit_16_9(1600, 1000);
    const heightBound = context.fit_16_9(1600, 500);

    assert.equal(widthBound.w, 1600);
    assert.equal(widthBound.h, 900);
    assert.equal(heightBound.w, 888);
    assert.equal(heightBound.h, 500);
});


test("best_grid_size returns a usable equal tile grid", () => {
    const {context} = loadApplication();

    const result = context.best_grid_size(6, 1920, 1080);

    assert.ok(result.w > 0);
    assert.ok(result.h > 0);
    assert.ok(result.rows >= 1);
    assert.ok(Math.abs(result.w / result.h - 16 / 9) < 0.01);
});


test("adaptive quality chooses the smallest rendition covering the tile", () => {
    const {context} = loadApplication();
    const qualities = ["audio_only", "360p", "720p60", "720p", "1080p60"];

    assert.equal(context.pick_quality_for_height(qualities, 500), "720p");
    assert.equal(context.pick_quality_for_height(qualities, 900), "1080p60");
    assert.equal(context.pick_quality_for_height(qualities, 1400), "1080p60");
    assert.equal(context.pick_quality_for_height(["audio_only"], 500), "best");
});


test("adaptive quality does not interrupt active audio or fresh startup streams", () => {
    const {context} = loadApplication();
    const reloaded = [];
    const oldDollar = context.$;
    context.$ = selector => {
        if (selector === "#streams .stream") {
            return {length: 3};
        }
        return oldDollar(selector);
    };
    context.stream_tile_by_name = () => ({hasClass: () => false});
    context.load_direct_stream = (_tile, name, _force, quality) => {
        reloaded.push({name, quality});
    };
    context.active_stream = "active";
    const stableCompletedAt = Date.now() - context.QUALITY_ADAPT_STARTUP_GRACE - 1000;
    const freshCompletedAt = Date.now() - 1000;
    function player(startupCompletedAt) {
        return {
            video: {clientHeight: 500},
            qualities: ["360p", "720p"],
            quality: "best",
            startup_pending: false,
            startup_completed_at: startupCompletedAt
        };
    }
    context.stream_players.active = player(stableCompletedAt);
    context.stream_players.fresh = player(freshCompletedAt);
    context.stream_players.stable = player(stableCompletedAt);

    context.adapt_stream_qualities();

    assert.deepEqual(reloaded, [{name: "stable", quality: "720p"}]);
});


test("chat width is clamped without reducing the stream area below its floor", () => {
    const {context} = loadApplication();

    assert.equal(context.clamp_chat_width(100, 1200, 240, 560), 240);
    assert.equal(context.clamp_chat_width(900, 1200, 240, 560), 560);
    assert.equal(context.clamp_chat_width(500, 800, 240, 560), 375);
});


test("saved chat width round-trips through local storage", () => {
    const {context, localStorage} = loadApplication();

    context.save_chat_width(337.6);

    assert.equal(localStorage.getItem("multitwitch_chat_width"), "338");
    assert.equal(context.load_saved_chat_width(), 338);
});

test("stream order comparison detects changed drag order", () => {
    const {context} = loadApplication();

    assert.equal(context.same_stream_order(["a", "b"], ["a", "b"]), true);
    assert.equal(context.same_stream_order(["a", "b"], ["b", "a"]), false);
    assert.equal(context.same_stream_order(["a", "b"], ["a", "b", "c"]), false);
});


test("Stream Together glow is acknowledged until matches disappear", () => {
    const {context} = loadApplication();

    assert.equal(context.should_highlight_stream_together(true), true);
    context.stream_together_matches_acknowledged = true;
    assert.equal(context.should_highlight_stream_together(true), false);
    assert.equal(context.should_highlight_stream_together(false), false);
    assert.equal(context.should_highlight_stream_together(true), true);
});


test("live-stream indexing drops channels absent from the latest poll", () => {
    const {context} = loadApplication();

    const indexed = context.index_live_streams([
        {user_login: "still_live", title: "Current"},
        {user_login: "newly_live", title: "New"}
    ]);

    assert.deepEqual(Object.keys(indexed).sort(), ["newly_live", "still_live"]);
    assert.equal(indexed.still_live.title, "Current");
    assert.equal(indexed.now_offline, undefined);
});

test("stream metadata cache indexes logins case-insensitively", () => {
    const {context} = loadApplication();

    context.cache_stream_metadata([
        {user_login: "GamesDoneQuick", title: "Speedruns", game_name: "Celeste"},
        {user_login: "other_channel", title: "Other", game_name: "Just Chatting"},
        {title: "Ignored"}
    ]);

    assert.equal(context.stream_metadata.gamesdonequick.title, "Speedruns");
    assert.equal(context.stream_metadata.other_channel.game_name, "Just Chatting");
    assert.equal(context.stream_metadata.undefined, undefined);
});


test("player latency prefers hls timing and falls back to the seekable edge", () => {
    const {context} = loadApplication();
    const video = {
        currentTime: 91,
        seekable: {
            length: 1,
            end() { return 100; }
        }
    };

    assert.equal(context.measure_player_latency({hls: {latency: 5.5}, video}), 5.5);
    assert.equal(context.measure_player_latency({hls: null, video}), 9);
});


test("latency and seek bounds use hls timeline data when native seek ranges are unavailable", () => {
    const {context} = loadApplication();
    const player = {
        hls: {
            latency: 0,
            latestLevelDetails: {live: true, edge: 120, age: 2, totalduration: 60}
        },
        video: {currentTime: 113, seekable: {length: 0}}
    };

    assert.equal(context.measure_player_latency(player), 9);
    const bounds = context.player_seek_bounds(player);
    assert.equal(bounds.start, 60);
    assert.equal(bounds.end, 120);
});


test("convergence target is the slowest healthy edge minus the holdback", () => {
    const {context} = loadApplication();

    // The slowest healthy channel defines the shared wall.
    assert.equal(context.compute_convergence_target([1000000, 1004000, 1002000], 4, 10), 996000);
    // A straggler (trailing the freshest edge by more than the limit) is a
    // stalled playlist and cannot drag the wall back...
    assert.equal(context.compute_convergence_target([1000000, 1020000], 4, 10), 1016000);
    // ...but a mild laggard still counts as the legitimate slowest pipeline.
    assert.equal(context.compute_convergence_target([1012000, 1020000], 4, 10), 1008000);
    // A single stream degenerates to holding behind its own edge -- the
    // property that lets convergence replace the sync feature without a mode.
    assert.equal(context.compute_convergence_target([500000], 4, 10), 496000);
    // No usable edges -> no target.
    assert.equal(context.compute_convergence_target([], 4, 10), null);
    assert.equal(context.compute_convergence_target([NaN], 4, 10), null);
});


test("convergence correction holds a dead-band, nudges asymmetrically, seeks big gaps", () => {
    const {context} = loadApplication();

    // Within the dead-band -> converged, leave it alone.
    const settled = context.convergence_correction(0.2, 100, 80, 120);
    assert.equal(settled.seek_to, null);
    assert.equal(settled.playback_rate, 1);

    // Behind the wall -> speed up, harder for wider gaps, capped at +15%.
    const behind = context.convergence_correction(1.0, 100, 80, 120);
    assert.equal(behind.seek_to, null);
    assert.ok(behind.playback_rate > 1 && behind.playback_rate <= 1.15);
    const further = context.convergence_correction(3.0, 100, 80, 120);
    assert.ok(further.playback_rate > behind.playback_rate);
    assert.ok(further.playback_rate <= 1.15);

    // Ahead of the wall -> gentle slowdown only, capped at -5%.
    const ahead = context.convergence_correction(-3.0, 100, 80, 120);
    assert.equal(ahead.seek_to, null);
    assert.ok(ahead.playback_rate < 1 && ahead.playback_rate >= 0.95);

    // A thin forward buffer vetoes speed-ups (they'd starve playback into the
    // delivery frontier) but not slow-downs or seeks.
    const starved = context.convergence_correction(2.0, 100, 80, 120, 1.0);
    assert.equal(starved.playback_rate, 1);
    assert.equal(starved.seek_to, null);
    const fed = context.convergence_correction(2.0, 100, 80, 120, 5.0);
    assert.ok(fed.playback_rate > 1);
    const slowLowBuf = context.convergence_correction(-2.0, 100, 80, 120, 1.0);
    assert.ok(slowLowBuf.playback_rate < 1);
    assert.equal(context.convergence_correction(6, 100, 80, 120, 0.5).seek_to, 106);

    // Past the seek threshold -> jump, clamped inside the seekable range.
    const jump = context.convergence_correction(6, 100, 80, 120);
    assert.equal(jump.seek_to, 106);
    assert.equal(jump.playback_rate, 1);
    assert.equal(context.convergence_correction(40, 100, 80, 120).seek_to, 119.75);
    assert.equal(context.convergence_correction(-6, 100, 80, 120).seek_to, 94);
});


test("edge PDT de-quantizes the 2s playlist staircase with playlist age", () => {
    const {context} = loadApplication();
    const player = {
        hls: {
            latestLevelDetails: {
                live: true,
                age: 1.5,
                fragments: [
                    {programDateTime: 1700000000000, duration: 2},
                    {programDateTime: 1700000002000, duration: 2}
                ]
            }
        },
        video: {}
    };

    // Last fragment PDT + its duration + time since the playlist was fetched.
    assert.equal(context.player_edge_pdt(player), 1700000005500);
    // Promoted prefetch segments can push the raw edge past realtime (their
    // content is still being written); the estimate is capped at the clock.
    const now = Date.now();
    const future = context.player_edge_pdt({
        hls: {
            latestLevelDetails: {
                live: true,
                age: 0,
                fragments: [{programDateTime: now, duration: 4.2}]
            }
        }
    });
    assert.ok(future <= Date.now() && future >= now - 50, "capped at the clock: " + (future - now));
    // VODs / playlists without PDT -> no edge estimate.
    assert.equal(context.player_edge_pdt({hls: {latestLevelDetails: {live: false, fragments: []}}}), null);
    assert.equal(context.player_edge_pdt({hls: {latestLevelDetails: {live: true, fragments: [{duration: 2}]}}}), null);
    assert.equal(context.player_edge_pdt({hls: null}), null);
});


test("long-segment playlists derive a deeper convergence holdback", () => {
    const {context} = loadApplication();
    const details = {
        live: true,
        fragments: [
            {programDateTime: 1700000000000, duration: 4.17},
            {programDateTime: 1700000004170, duration: 4.17},
            {programDateTime: 1700000008340, duration: 4.17}
        ]
    };

    assert.equal(context.details_segment_duration(details), 4.17);
    assert.equal(context.details_holdback_seconds(details), 10);
    assert.ok(Math.abs(context.details_min_buffer_seconds(details) - 6.255) < 0.001);
    assert.equal(context.details_startup_latency_seconds(details), 12);
    assert.equal(context.details_holdback_seconds({fragments: [{duration: 2}]}), 6);
    assert.equal(context.details_startup_latency_seconds({fragments: [{duration: 2}]}), 8);
});


test("straggler thresholds scale with segment duration and have hysteresis", () => {
    const {context} = loadApplication();

    assert.equal(context.details_straggler_enter_seconds({fragments: [{duration: 2}]}), 10);
    assert.equal(context.details_straggler_exit_seconds({fragments: [{duration: 2}]}), 8);
    assert.ok(Math.abs(context.details_straggler_enter_seconds({fragments: [{duration: 4.17}]}) - 12.51) < 0.001);
    assert.ok(Math.abs(context.details_straggler_exit_seconds({fragments: [{duration: 4.17}]}) - 10.51) < 0.001);
});


test("displayed latency prefers the capped PDT read over hls.latency", () => {
    const {context} = loadApplication();
    const base = Date.now();
    // hls.latency measures against the raw in-flight edge (here inflated to
    // 11s); the PDT read caps the edge at the clock -> honest ~7s.
    const player = {
        hls: {
            latency: 11,
            playingDate: new Date(base - 7000),
            latestLevelDetails: {
                live: true,
                age: 0,
                fragments: [{programDateTime: base, duration: 4.2}]
            }
        },
        video: {currentTime: 100}
    };
    const shown = context.display_stream_latency(player);
    assert.ok(Math.abs(shown - 7) < 0.1, "capped PDT latency, got " + shown);
    // Without PDT it falls back to the classic measurement.
    assert.equal(context.display_stream_latency({hls: {latency: 5.5}, video: {currentTime: 100}}), 5.5);
});


test("displayed sync offset compares playback to the shared wall", () => {
    const {context} = loadApplication();
    const base = Date.now();
    function fakePlayer(edgeOffsetMs, playingOffsetMs, duration) {
        return {
            engine: "hls",
            manual_paused: false,
            recovering: false,
            startup_pending: false,
            hls: {
                playingDate: new Date(base + playingOffsetMs),
                latestLevelDetails: {
                    live: true,
                    age: 0,
                    fragments: [
                        {programDateTime: base + edgeOffsetMs - duration * 2000, duration},
                        {programDateTime: base + edgeOffsetMs - duration * 1000, duration}
                    ]
                }
            },
            video: {currentTime: 100}
        };
    }

    context.stream_players.normal = fakePlayer(0, -10000, 2);
    context.stream_players.long = fakePlayer(0, -10400, 4.17);

    assert.equal(context.display_stream_sync_offset(context.stream_players.normal), 0);
    assert.ok(Math.abs(context.display_stream_sync_offset(context.stream_players.long) - 0.4) < 0.001);
    assert.equal(context.format_stream_sync_offset(0.4), "+0.4s");
    assert.equal(context.format_stream_sync_offset(-0.4), "-0.4s");
});


test("playing PDT reads hls.js playingDate and tolerates its absence", () => {
    const {context} = loadApplication();

    assert.equal(context.player_playing_pdt({hls: {playingDate: new Date(1700000001234)}}), 1700000001234);
    assert.equal(context.player_playing_pdt({hls: {playingDate: null}}), null);
    assert.equal(context.player_playing_pdt(null), null);
});


test("convergence steers every healthy stream toward the shared wall", () => {
    const {context} = loadApplication();
    const base = Date.now();
    function fakePlayer(edgeOffsetMs, playingOffsetMs) {
        return {
            engine: "hls",
            manual_paused: false,
            recovering: false,
            startup_pending: false,
            last_convergence_seek_at: 0,
            hls: {
                playingDate: new Date(base + playingOffsetMs),
                latestLevelDetails: {
                    live: true,
                    age: 0,
                    fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
                }
            },
            video: {
                currentTime: 100,
                playbackRate: 1,
                paused: false,
                seekable: {length: 1, start: () => 50, end: () => 120}
            }
        };
    }
    // Slowest edge (base-6000) defines the wall: target = base - 12000.
    context.stream_players.slow = fakePlayer(-6000, -12100);  // 0.1s off -> dead-band
    context.stream_players.fast = fakePlayer(-4000, -14000);  // 2s behind -> speeds up
    context.stream_players.lost = fakePlayer(-5000, -22000);  // 10s behind -> seeks

    context.run_convergence();

    assert.equal(context.stream_players.slow.video.playbackRate, 1);
    assert.ok(context.stream_players.fast.video.playbackRate > 1);
    assert.equal(context.stream_players.lost.video.playbackRate, 1);
    assert.equal(context.stream_players.lost.video.currentTime, 110);
    assert.ok(context.stream_players.lost.last_convergence_seek_at > 0);
});


test("long-segment streams anchor the shared wall at their safe holdback", () => {
    const {context} = loadApplication();
    const base = Date.now();
    function fakePlayer(edgeOffsetMs, playingOffsetMs, duration) {
        return {
            engine: "hls",
            manual_paused: false,
            recovering: false,
            startup_pending: false,
            last_convergence_seek_at: 0,
            hls: {
                playingDate: new Date(base + playingOffsetMs),
                latestLevelDetails: {
                    live: true,
                    age: 0,
                    fragments: [
                        {programDateTime: base + edgeOffsetMs - duration * 2000, duration},
                        {programDateTime: base + edgeOffsetMs - duration * 1000, duration}
                    ]
                }
            },
            video: {
                currentTime: 100,
                playbackRate: 1,
                paused: false,
                seekable: {length: 1, start: () => 50, end: () => 120}
            }
        };
    }

    context.stream_players.normal = fakePlayer(0, -6000, 2);
    context.stream_players.long = fakePlayer(0, -10000, 4.17);

    context.run_convergence();

    assert.equal(context.stream_players.normal.video.playbackRate, 1);
    assert.equal(context.stream_players.long.video.playbackRate, 1);
});


test("straggler state requires consecutive enter and exit ticks", () => {
    const {context} = loadApplication();
    const fresh = {
        name: "fresh",
        player: {},
        edge_pdt: 20000,
        playing_pdt: 10000,
        holdback_seconds: 6,
        straggler_enter_seconds: 10,
        straggler_exit_seconds: 8,
        is_straggler: false
    };
    const stale = {
        name: "stale",
        player: {},
        edge_pdt: 9000,
        playing_pdt: 8000,
        holdback_seconds: 6,
        straggler_enter_seconds: 10,
        straggler_exit_seconds: 8,
        is_straggler: false
    };

    context.update_stream_straggler_badge = () => {};

    context.update_convergence_straggler_states([fresh, stale]);
    assert.equal(stale.player.is_straggler, undefined);
    context.update_convergence_straggler_states([fresh, stale]);
    assert.equal(stale.player.is_straggler, undefined);
    context.update_convergence_straggler_states([fresh, stale]);
    assert.equal(stale.player.is_straggler, true);
    assert.equal(context.compute_convergence_target_for_players([fresh, stale]), 14000);

    stale.edge_pdt = 12500; // 7.5s behind, below the 8s exit threshold.
    context.update_convergence_straggler_states([fresh, stale]);
    assert.equal(stale.player.is_straggler, true);
    context.update_convergence_straggler_states([fresh, stale]);
    assert.equal(stale.player.is_straggler, false);
    assert.equal(context.compute_convergence_target_for_players([fresh, stale]), 6500);
});


test("long-segment speedups wait for a segment-sized forward buffer", () => {
    const {context} = loadApplication();

    const starved = context.convergence_correction(2.0, 100, 80, 120, 5.0, 6.255);
    assert.equal(starved.playback_rate, 1);

    const fed = context.convergence_correction(2.0, 100, 80, 120, 7.0, 6.255);
    assert.ok(fed.playback_rate > 1);
});


test("the nosync kill switch leaves playback untouched", () => {
    const {context, localStorage} = loadApplication();
    localStorage.setItem("multitwitch.nosync", "1");

    context.initialize_convergence();
    assert.equal(context.convergence_disabled, true);

    const base = Date.now();
    context.stream_players.example = {
        engine: "hls",
        manual_paused: false,
        recovering: false,
        startup_pending: false,
        last_convergence_seek_at: 0,
        hls: {
            playingDate: new Date(base - 20000),
            latestLevelDetails: {
                live: true,
                age: 0,
                fragments: [{programDateTime: base - 2000, duration: 2}]
            }
        },
        video: {
            currentTime: 100,
            playbackRate: 1,
            seekable: {length: 1, start: () => 50, end: () => 120}
        }
    };

    context.run_convergence();

    assert.equal(context.stream_players.example.video.playbackRate, 1);
    assert.equal(context.stream_players.example.video.currentTime, 100);
});


test("the wall can never demand a stream play inside its own holdback", () => {
    const {context} = loadApplication();
    const base = Date.now();
    function fakePlayer(edgeOffsetMs, playingOffsetMs, ownLatency) {
        return {
            engine: "hls",
            manual_paused: false,
            recovering: false,
            startup_pending: false,
            last_convergence_seek_at: 0,
            hls: {
                latency: ownLatency,
                playingDate: new Date(base + playingOffsetMs),
                latestLevelDetails: {
                    live: true,
                    age: 0,
                    fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
                }
            },
            video: {
                currentTime: 100,
                playbackRate: 1,
                seekable: {length: 1, start: () => 50, end: () => 120}
            }
        };
    }
    // Anchor on the wall (edge -2000 -> wall = base - 8000).
    context.stream_players.anchor = fakePlayer(-2000, -8100, 6);
    // The victim's PDT math says 10s behind the wall (a hard seek), but its own
    // measured latency is 7s -- only 1s of forward room exists before the
    // delivery frontier. The clamp turns the seek into a gentle nudge.
    context.stream_players.victim = fakePlayer(-2000, -18000, 7);

    context.run_convergence();

    assert.equal(context.stream_players.victim.video.currentTime, 100);
    const rate = context.stream_players.victim.video.playbackRate;
    assert.ok(rate > 1 && rate <= 1.15, "clamped to a nudge, not a seek: " + rate);
});


test("a channel with a broken PDT clock self-holds instead of poisoning the wall", () => {
    const {context} = loadApplication();
    const base = Date.now();
    // Edge PDT hours away from the client clock -> demoted to the latency
    // fallback (hold ~4s behind its own edge), not used for the shared target.
    context.stream_players.broken = {
        engine: "hls",
        manual_paused: false,
        recovering: false,
        startup_pending: false,
        last_convergence_seek_at: 0,
        hls: {
            latency: 10,
            playingDate: new Date(base - 7200000),
            latestLevelDetails: {
                live: true,
                age: 0,
                fragments: [{programDateTime: base - 7200000, duration: 2}]
            }
        },
        video: {
            currentTime: 100,
            playbackRate: 1,
            seekable: {length: 1, start: () => 50, end: () => 120}
        }
    };

    context.run_convergence();

    // latency 10 vs holdback 6 -> 4s behind -> at the seek threshold, jumps 4s.
    assert.equal(context.stream_players.broken.video.currentTime, 104);
});


test("snap-to-live seeks to the shared wall, not the raw edge", () => {
    const {context} = loadApplication();
    const base = Date.now();
    function fakePlayer(edgeOffsetMs, playingOffsetMs, currentTime) {
        return {
            engine: "hls",
            manual_paused: false,
            recovering: false,
            startup_pending: false,
            hls: {
                startLoadCalls: 0,
                startLoad(position) { this.startLoadCalls += 1; this.lastStart = position; },
                playingDate: new Date(base + playingOffsetMs),
                latestLevelDetails: {
                    live: true,
                    age: 0,
                    fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
                }
            },
            video: {
                currentTime,
                playbackRate: 1,
                seekable: {length: 1, start: () => 50, end: () => 120}
            }
        };
    }
    // Anchor sits exactly on the wall (edge -6000 -> wall = base - 12000).
    context.stream_players.anchor = fakePlayer(-6000, -12000, 100);
    // The lagging player is 3s behind the wall; ⟳ jumps it straight there.
    context.stream_players.lagging = fakePlayer(-4000, -15000, 100);

    context.snap_player_to_live(context.stream_players.lagging);

    assert.equal(context.stream_players.lagging.video.currentTime, 103);
    assert.equal(context.stream_players.lagging.hls.startLoadCalls, 1);
    assert.equal(context.stream_players.lagging.hls.lastStart, -1);

    // Single stream: the wall degenerates to its own edge minus the holdback,
    // so ⟳ lands 6s back -- where the controller would hold it anyway.
    delete context.stream_players.anchor;
    delete context.stream_players.lagging;
    context.stream_players.solo = fakePlayer(-1000, -9000, 100);
    context.snap_player_to_live(context.stream_players.solo);
    assert.equal(context.stream_players.solo.video.currentTime, 102);
});


test("snap-to-live falls back to just-behind-the-edge without PDT", () => {
    const {context} = loadApplication();
    const player = {
        engine: "hls",
        manual_paused: false,
        recovering: false,
        startup_pending: false,
        hls: null,
        video: {
            currentTime: 100,
            seekable: {length: 1, start: () => 50, end: () => 120}
        }
    };
    context.stream_players.example = player;

    context.snap_player_to_live(player);

    assert.equal(player.video.currentTime, 119.5);
});


test("startup bias raises the hold-back so new streams are born on the wall", () => {
    const {context} = loadApplication();
    const base = Date.now();
    // Healthy anchor already playing on the wall (edge -6000 -> wall -12000).
    context.stream_players.anchor = {
        engine: "hls",
        manual_paused: false,
        recovering: false,
        startup_pending: false,
        hls: {
            playingDate: new Date(base - 12000),
            latestLevelDetails: {
                live: true,
                age: 0,
                fragments: [{programDateTime: base - 8000, duration: 2}]
            }
        },
        video: {currentTime: 100, seekable: {length: 1, start: () => 50, end: () => 120}}
    };
    const hls = {config: {liveSyncDuration: 8}};
    context.stream_players.fresh = {engine: "hls", startup_pending: true, hls};
    function details(edgeOffsetMs) {
        return {
            live: true,
            age: 0,
            fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
        };
    }

    // Fast channel (edge -1000) joining a slower group: start 11s back, on the
    // wall, instead of 8s back and ahead of it.
    context.bias_startup_toward_wall("fresh", hls, details(-1000));
    assert.equal(hls.config.liveSyncDuration, 11);

    // A channel slower than the wall never starts closer than the smooth-start
    // floor.
    context.bias_startup_toward_wall("fresh", hls, details(-13000));
    assert.equal(hls.config.liveSyncDuration, 8);

    // After startup the bias no-ops (the convergence tick has authority).
    hls.config.liveSyncDuration = 8;
    context.stream_players.fresh.startup_pending = false;
    context.bias_startup_toward_wall("fresh", hls, details(-1000));
    assert.equal(hls.config.liveSyncDuration, 8);

    // No other healthy players -> no wall -> default hold-back stands.
    context.stream_players.fresh.startup_pending = true;
    delete context.stream_players.anchor;
    context.bias_startup_toward_wall("fresh", hls, details(-1000));
    assert.equal(hls.config.liveSyncDuration, 8);
});


test("startup sync waits for pending initial streams before playback", () => {
    const {context} = loadApplication();
    const base = Date.now() - 10000;
    let plays = 0;
    context.play_stream_with_target_audio = (_name, video) => {
        plays += 1;
        video.paused = false;
    };
    context.streams = ["ready", "pending"];
    context.stream_load_pending.pending = true;
    const hls = {config: {liveSyncDuration: 8}};
    const video = {
        paused: true,
        currentTime: 100,
        buffered: {length: 1, start: () => 100, end: () => 103}
    };
    context.stream_players.ready = {
        name: "ready",
        engine: "hls",
        startup_pending: true,
        startup_sync_released: false,
        manual_paused: false,
        hls,
        video
    };

    context.coordinate_startup_toward_wall("ready", hls, {
        live: true,
        age: 0,
        fragments: [{programDateTime: base - 2000, duration: 2}]
    });

    assert.equal(plays, 0);
    assert.equal(context.stream_players.ready.startup_sync_released, false);

    context.stream_load_pending.pending = false;
    context.maybe_release_startup_sync();

    assert.equal(plays, 1);
    assert.equal(context.stream_players.ready.startup_sync_released, true);
});


test("startup sync aligns initial players to a shared startup wall", () => {
    const {context} = loadApplication();
    const base = Date.now() - 10000;
    const played = [];
    context.play_stream_with_target_audio = (name, video) => {
        played.push(name);
        video.paused = false;
    };
    context.streams = ["fast", "slow"];
    context.stream_load_pending.slow = true;

    function addPlayer(name) {
        const hls = {config: {liveSyncDuration: 8}};
        const video = {
            paused: true,
            currentTime: 100,
            buffered: {length: 1, start: () => 100, end: () => 103}
        };
        context.stream_players[name] = {
            name,
            engine: "hls",
            startup_pending: true,
            startup_sync_released: false,
            manual_paused: false,
            hls,
            video
        };
        return hls;
    }
    function details(edgeOffsetMs) {
        return {
            live: true,
            age: 0,
            fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
        };
    }

    const fast = addPlayer("fast");
    const slow = addPlayer("slow");

    context.coordinate_startup_toward_wall("fast", fast, details(0));
    assert.deepEqual(played, []);

    context.stream_load_pending.slow = false;
    context.coordinate_startup_toward_wall("slow", slow, details(-4000));

    assert.deepEqual(played.sort(), ["fast", "slow"]);
    assert.ok(Math.abs(fast.config.liveSyncDuration - 10) < 0.05);
    assert.ok(Math.abs(slow.config.liveSyncDuration - 6) < 0.05);
});


test("startup sync seeks to the coordinated media position without restarting hls loading", () => {
    const {context} = loadApplication();
    const base = Date.now() - 10000;
    const played = [];
    context.play_stream_with_target_audio = (name, video) => {
        played.push(name);
        video.paused = false;
    };
    context.streams = ["fast", "slow"];
    context.stream_load_pending.slow = true;

    function addPlayer(name) {
        const hls = {
            config: {liveSyncDuration: 8},
            startLoads: [],
            stopLoads: 0,
            startLoad(position) {
                this.startLoads.push(position);
            },
            stopLoad() {
                this.stopLoads += 1;
            }
        };
        const video = {
            paused: true,
            currentTime: 100,
            buffered: {length: 1, start: () => 100, end: () => 105},
            seekable: {length: 1, start: () => 80, end: () => 120}
        };
        context.stream_players[name] = {
            name,
            engine: "hls",
            startup_pending: true,
            startup_sync_released: false,
            manual_paused: false,
            hls,
            video
        };
        return hls;
    }
    function details(edgeOffsetMs) {
        return {
            live: true,
            age: 1,
            edge: 120,
            totalduration: 40,
            fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
        };
    }

    const fast = addPlayer("fast");
    const slow = addPlayer("slow");

    context.coordinate_startup_toward_wall("fast", fast, details(4000));
    assert.deepEqual(fast.startLoads, []);

    context.stream_load_pending.slow = false;
    context.coordinate_startup_toward_wall("slow", slow, details(0));

    assert.deepEqual(played.sort(), ["fast", "slow"]);
    assert.equal(fast.stopLoads, 0);
    assert.equal(slow.stopLoads, 0);
    assert.ok(Math.abs(fast.config.liveSyncDuration - 10) < 0.05);
    assert.deepEqual(fast.startLoads, []);
    assert.ok(Math.abs(context.stream_players.fast.video.currentTime - 111) < 0.05);
    assert.ok(Math.abs(slow.config.liveSyncDuration - 6) < 0.05);
    assert.deepEqual(slow.startLoads, []);
    assert.ok(Math.abs(context.stream_players.slow.video.currentTime - 115) < 0.05);
});


test("startup sync asks hls to load the coordinated position only when it cannot seek there yet", () => {
    const {context} = loadApplication();
    let plays = 0;
    const hls = {
        config: {liveSyncDuration: 8},
        startLoads: [],
        stopLoads: 0,
        startLoad(position) {
            this.startLoads.push(position);
        },
        stopLoad() {
            this.stopLoads += 1;
        }
    };
    const video = {
        paused: true,
        currentTime: 20,
        seekable: {length: 1, start: () => 0, end: () => 40}
    };
    context.play_stream_with_target_audio = (_name, target) => {
        plays += 1;
        target.paused = false;
    };
    context.stream_players.example = {
        name: "example",
        engine: "hls",
        startup_pending: true,
        startup_sync_released: false,
        manual_paused: false,
        hls,
        video,
        startup_sync_start_position: 60
    };

    context.release_startup_player(context.stream_players.example);

    assert.equal(plays, 1);
    assert.equal(hls.stopLoads, 0);
    assert.deepEqual(hls.startLoads, [60]);
    assert.equal(video.currentTime, 20);
});


test("startup sync waits for buffer before starting on the stable wall", () => {
    const {context} = loadApplication();
    const base = Date.now() - 1000;
    let plays = 0;
    context.play_stream_with_target_audio = (_name, video) => {
        plays += 1;
        video.paused = false;
    };
    context.streams = ["example"];
    const hls = {config: {liveSyncDuration: 8}};
    const video = {
        paused: true,
        currentTime: 100,
        buffered: {length: 1, start: () => 100, end: () => 101}
    };
    context.stream_players.example = {
        name: "example",
        engine: "hls",
        startup_pending: true,
        startup_sync_released: false,
        manual_paused: false,
        hls,
        video
    };
    const details = {
        live: true,
        age: 0,
        fragments: [{programDateTime: base - 2000, duration: 2}]
    };

    context.coordinate_startup_toward_wall("example", hls, details);
    assert.equal(plays, 0);
    assert.equal(context.stream_players.example.startup_sync_released, false);

    video.buffered = {length: 1, start: () => 100, end: () => 102.5};
    context.maybe_release_startup_sync();

    assert.equal(plays, 1);
    assert.equal(hls.config.liveSyncDuration, 6);
});


test("startup sync timeout falls back to the smooth-start wall", () => {
    const {context} = loadApplication();
    const base = Date.now() - 1000;
    let plays = 0;
    context.play_stream_with_target_audio = (_name, video) => {
        plays += 1;
        video.paused = false;
    };
    const hls = {config: {liveSyncDuration: 8}};
    const video = {
        paused: true,
        currentTime: 100,
        buffered: {length: 1, start: () => 100, end: () => 101}
    };
    context.stream_players.example = {
        name: "example",
        engine: "hls",
        startup_pending: true,
        startup_sync_released: false,
        manual_paused: false,
        hls,
        video,
        startup_sync_ready: true,
        startup_sync_details: {
            live: true,
            age: 0,
            fragments: [{programDateTime: base - 2000, duration: 2}]
        }
    };

    context.release_startup_sync_players(null, true);

    assert.equal(plays, 1);
    assert.equal(hls.config.liveSyncDuration, 8);
});


test("startup fallback recomputes the shared wall from smooth-start holdbacks", () => {
    const {context} = loadApplication();
    const base = Date.now() - 10000;
    const played = [];
    context.play_stream_with_target_audio = (name, video) => {
        played.push(name);
        video.paused = false;
    };

    function addPlayer(name, edgeOffsetMs) {
        const hls = {config: {liveSyncDuration: 8}};
        const video = {
            paused: true,
            currentTime: 100,
            buffered: {length: 1, start: () => 100, end: () => 101}
        };
        context.stream_players[name] = {
            name,
            engine: "hls",
            startup_pending: true,
            startup_sync_released: false,
            manual_paused: false,
            hls,
            video,
            startup_sync_ready: true,
            startup_sync_details: {
                live: true,
                age: 0,
                fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
            }
        };
        return hls;
    }

    const slow = addPlayer("slow", 0);
    const fast = addPlayer("fast", 4000);

    context.release_startup_sync_players(null, true);

    assert.deepEqual(played.sort(), ["fast", "slow"]);
    assert.equal(slow.config.liveSyncDuration, 8);
    assert.equal(fast.config.liveSyncDuration, 12);
});


test("startup sync ignores straggler edges when deriving the initial wall", () => {
    const {context} = loadApplication();
    const base = Date.now() - 30000;
    const played = [];
    context.play_stream_with_target_audio = (name, video) => {
        played.push(name);
        video.paused = false;
    };

    function addPlayer(name, edgeOffsetMs) {
        const hls = {config: {liveSyncDuration: 8}};
        const video = {
            paused: true,
            currentTime: 100,
            buffered: {length: 1, start: () => 100, end: () => 103}
        };
        context.stream_players[name] = {
            name,
            engine: "hls",
            startup_pending: true,
            startup_sync_released: false,
            manual_paused: false,
            hls,
            video,
            startup_sync_ready: true,
            startup_sync_details: {
                live: true,
                age: 0,
                fragments: [{programDateTime: base + edgeOffsetMs - 2000, duration: 2}]
            }
        };
        return hls;
    }

    const straggler = addPlayer("straggler", 0);
    const fresh = addPlayer("fresh", 20000);

    context.release_startup_sync_players(null, false);

    assert.deepEqual(played.sort(), ["fresh", "straggler"]);
    assert.equal(fresh.config.liveSyncDuration, 6);
    // The stale stream is released, but it self-starts at its own floor instead
    // of dragging the shared startup wall behind the fresh stream.
    assert.equal(straggler.config.liveSyncDuration, 6);
});


test("startup straggler filtering is segment-aware", () => {
    const {context} = loadApplication();
    const base = Date.now() - 30000;
    const played = [];
    context.play_stream_with_target_audio = (name, video) => {
        played.push(name);
        video.paused = false;
    };

    function addPlayer(name, edgeOffsetMs, duration) {
        const hls = {config: {liveSyncDuration: 8}};
        const video = {
            paused: true,
            currentTime: 100,
            buffered: {length: 1, start: () => 100, end: () => 105}
        };
        context.stream_players[name] = {
            name,
            engine: "hls",
            startup_pending: true,
            startup_sync_released: false,
            manual_paused: false,
            hls,
            video,
            startup_sync_ready: true,
            startup_sync_details: {
                live: true,
                age: 0,
                fragments: [{programDateTime: base + edgeOffsetMs - duration * 1000, duration}]
            }
        };
        return hls;
    }

    const long = addPlayer("long", 0, 4.17);
    const fresh = addPlayer("fresh", 11000, 2);

    context.release_startup_sync_players(null, false);

    assert.deepEqual(played.sort(), ["fresh", "long"]);
    assert.equal(long.config.liveSyncDuration, 10);
    assert.equal(fresh.config.liveSyncDuration, 16);
});


test("engine selection prefers hls.js wherever it runs, native only as fallback", () => {
    const {context} = loadApplication();
    const supportedHls = {isSupported: () => true};
    const unsupportedHls = {isSupported: () => false};
    const nativeVideo = {
        canPlayType: (type) => (type === "application/vnd.apple.mpegurl" ? "maybe" : "")
    };
    const noNativeVideo = {canPlayType: () => ""};

    // hls.js available -> always hls.js, even where native HLS is also offered
    // (Chromium 142+'s native demuxer can't parse Twitch's MPEG-TS).
    context.Hls = supportedHls;
    context.window.Hls = supportedHls;
    assert.equal(context.desired_player_engine("a", nativeVideo), "hls");
    assert.equal(context.desired_player_engine("a", noNativeVideo), "hls");

    // hls.js unavailable (e.g. iOS Safari, no MSE) -> native HLS where offered.
    context.Hls = unsupportedHls;
    context.window.Hls = unsupportedHls;
    assert.equal(context.desired_player_engine("a", nativeVideo), "native");
    // Neither engine available -> nothing to play with.
    assert.equal(context.desired_player_engine("a", noNativeVideo), null);
});


test("native playback failure pins the channel to hls.js on reload", () => {
    const {context} = loadApplication();
    const hlsMock = {isSupported: () => true};
    context.Hls = hlsMock;
    context.window.Hls = hlsMock;
    const video = {
        canPlayType(type) {
            return type === "application/vnd.apple.mpegurl" ? "maybe" : "";
        }
    };
    context.stream_players.example = {engine: "native", video};
    context.mark_stream_stalled = () => {};
    let recoveryScheduled = false;
    context.schedule_stream_recovery = () => { recoveryScheduled = true; };

    context.handle_stream_playback_failure("example");

    assert.equal(context.stream_force_hls_js.example, true);
    assert.equal(recoveryScheduled, true);
});


test("hls diagnostics retain useful failure data without URL tokens", () => {
    const {context} = loadApplication();

    const diagnostics = context.hls_error_diagnostics("example", {
        type: "networkError",
        details: "manifestLoadError",
        reason: "Forbidden",
        response: {
            code: 403,
            text: "Forbidden",
            url: "https://usher.ttvnw.net/api/channel/hls/example.m3u8?token=secret&sig=secret"
        }
    });

    assert.equal(diagnostics.channel, "example");
    assert.equal(diagnostics.type, "networkError");
    assert.equal(diagnostics.details, "manifestLoadError");
    assert.equal(diagnostics.response_code, 403);
    assert.equal(diagnostics.url, "https://usher.ttvnw.net/[redacted].m3u8");
});


test("hls diagnostics redact URLs embedded in parser reasons", () => {
    const {context} = loadApplication();
    const diagnostics = context.hls_error_diagnostics("example", {
        reason: "media sequence mismatch 993: https://cdn.ttvnw.net/v1/segment/private.mp4?token=secret\n" +
            "#EXT-X-MAP:URI=\"https://cdn.ttvnw.net/v1/segment/init.mp4?dna=secret\"",
        response: {text: "https://cdn.ttvnw.net/v1/segment/response.mp4?sig=secret"}
    });

    assert.match(diagnostics.reason, /media sequence mismatch 993/);
    assert.match(diagnostics.reason, /https:\/\/cdn\.ttvnw\.net\/\[redacted\]\.mp4/);
    assert.doesNotMatch(diagnostics.reason, /secret|\/v1\/segment\//);
    assert.doesNotMatch(diagnostics.response_text, /secret|\/v1\/segment\//);
});


test("saved unmuted audio is eligible for autoplay restoration", () => {
    const {context} = loadApplication();

    assert.equal(context.saved_audio_should_start_unlocked(false), true);
    assert.equal(context.saved_audio_should_start_unlocked(true), false);
});

test("unlocking audio persists an unmuted master state for refresh", () => {
    const {context, localStorage} = loadApplication();
    context.update_mute_button = () => {};
    context.update_volume_display = () => {};
    context.sync_active_stream_audio = () => {};
    context.master_muted = true;
    context.master_volume = 0;

    context.unlock_audio();

    assert.equal(context.audio_unlocked, true);
    assert.equal(context.master_muted, false);
    assert.equal(context.master_volume, 0.7);
    assert.equal(localStorage.getItem("multitwitch.masterMuted"), "false");
    assert.equal(localStorage.getItem("multitwitch.masterVolume"), "0.7");
});


test("clicking the page while already unlocked does not override an explicit mute", () => {
    const {context} = loadApplication();
    let syncs = 0;
    context.update_mute_button = () => {};
    context.update_volume_display = () => {};
    context.sync_active_stream_audio = () => { syncs += 1; };
    // User has interacted and then deliberately muted the master.
    context.audio_unlocked = true;
    context.master_muted = true;
    context.master_volume = 0.7;

    // A stray document click (set_active_stream / the audio-unlock handler) must
    // leave the mute intact rather than silently un-muting and desyncing the UI.
    context.unlock_audio();

    assert.equal(context.master_muted, true);
    assert.equal(context.master_volume, 0.7);
    assert.equal(syncs, 0);
    assert.equal(context.audio_restore_pending, false);
});


test("master mute button toggles cleanly in both directions", () => {
    const {context} = loadApplication();
    context.update_mute_button = () => {};
    context.update_volume_display = () => {};
    context.sync_active_stream_audio = () => {};
    context.audio_unlocked = true;
    context.master_muted = false;
    context.master_volume = 0.7;

    // Mute, then the click bubbles to the document audio-unlock handler.
    context.toggle_master_mute();
    context.unlock_audio();
    assert.equal(context.master_muted, true);

    // Unmute, then the same bubbling click -- the toggle must stick at unmuted
    // instead of being reset back to muted by unlock_audio.
    context.toggle_master_mute();
    context.unlock_audio();
    assert.equal(context.master_muted, false);
});


test("audible restore clears the element's persistent muted default", () => {
    const {context} = loadApplication();
    const attributes = new Set(["muted"]);
    const video = {
        muted: true,
        defaultMuted: true,
        setAttribute(name) { attributes.add(name); },
        removeAttribute(name) { attributes.delete(name); }
    };

    context.set_video_muted(video, false);
    assert.equal(video.muted, false);
    assert.equal(video.defaultMuted, false);
    assert.equal(attributes.has("muted"), false);

    context.set_video_muted(video, true);
    assert.equal(video.muted, true);
    assert.equal(video.defaultMuted, true);
    assert.equal(attributes.has("muted"), true);
});


test("autoplay rejection only relocks an optimistic refresh restore", async () => {
    const {context} = loadApplication();
    const blocked = new Error("Autoplay blocked");
    blocked.name = "NotAllowedError";
    const video = {
        muted: false,
        volume: 0.7,
        play() { return Promise.reject(blocked); }
    };
    context.update_mute_button = () => {};
    context.update_volume_display = () => {};
    context.sync_active_stream_audio = () => {};
    context.audio_unlocked = true;
    context.audio_restore_pending = true;

    context.safe_play(video);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(context.audio_unlocked, false);
    assert.equal(video.muted, true);
    assert.equal(video.defaultMuted, true);

    video.muted = false;
    context.audio_unlocked = true;
    context.audio_restore_pending = false;
    context.safe_play(video);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(context.audio_unlocked, true);
    assert.equal(video.muted, false);
});

test("unmuted playback restore plays audibly without a muted unmute dance", async () => {
    const {context} = loadApplication();
    let mutedAtPlay = null;
    const video = {
        paused: true,
        muted: true,
        volume: 0,
        play() {
            mutedAtPlay = this.muted;
            return Promise.resolve();
        }
    };

    context.apply_video_audio(video, true, 0.7);
    await new Promise(resolve => setTimeout(resolve, 0));

    // The element is unmuted before play() so a real autoplay block can reject
    // (and reach the muted fallback) instead of being masked by a muted play.
    assert.equal(mutedAtPlay, false);
    assert.equal(video.muted, false);
    assert.equal(video.volume, 0.7);
});

test("blocked audible startup playback falls back to muted, preserving saved intent", async () => {
    const {context, localStorage} = loadApplication();
    const blocked = new Error("Autoplay blocked");
    blocked.name = "NotAllowedError";
    const video = {
        paused: true,
        muted: false,
        volume: 0.7,
        play() {
            return Promise.reject(blocked);
        }
    };
    context.update_mute_button = () => {};
    context.update_volume_display = () => {};
    context.sync_active_stream_audio = () => {};
    context.audio_unlocked = true;
    context.audio_restore_pending = true;
    context.master_muted = false;

    context.apply_video_audio(video, true, 0.7);
    await new Promise(resolve => setTimeout(resolve, 0));

    // The audible play is refused, so we relock to a muted fallback...
    assert.equal(context.audio_unlocked, false);
    assert.equal(context.audio_restore_pending, false);
    assert.equal(video.muted, true);
    assert.equal(video.defaultMuted, true);
    assert.equal(video.volume, 0);
    // ...but the saved unmuted intent survives so a later click restores sound.
    assert.equal(context.master_muted, false);
    assert.equal(localStorage.getItem("multitwitch.masterMuted"), null);
});


test("follow detection is case-insensitive", () => {
    const {context} = loadApplication();
    context.followed_channels = [{broadcaster_login: "LilAggy"}];

    assert.equal(context.is_followed_channel("lilaggy"), true);
    assert.equal(context.is_followed_channel("another_stream"), false);
});


test("live follow tooltip includes the game and stream title", () => {
    const {context} = loadApplication();

    assert.equal(context.live_follow_tooltip({
        game_name: "Dark Souls III",
        title: "No-hit attempts"
    }), "Game: Dark Souls III\nTitle: No-hit attempts");
    assert.equal(context.live_follow_tooltip(null), "");
});


test("stream API diagnostics identify failures before hls.js starts", () => {
    const {context} = loadApplication();

    const diagnostics = context.stream_api_error_diagnostics("example", {
        status: 502,
        statusText: "Bad Gateway",
        responseJSON: {error: "Stream resolver exited unexpectedly."}
    }, "error", "Bad Gateway");

    assert.equal(diagnostics.channel, "example");
    assert.equal(diagnostics.status, 502);
    assert.equal(diagnostics.status_text, "Bad Gateway");
    assert.equal(diagnostics.response, "Stream resolver exited unexpectedly.");
});


test("buffered paused media is not treated as a dead stream", () => {
    const {context} = loadApplication();

    assert.equal(context.media_is_ready_but_paused({paused: true, error: null, readyState: 4}), true);
    assert.equal(context.media_is_ready_but_paused({paused: true, error: null, readyState: 1}), false);
    assert.equal(context.media_is_ready_but_paused({paused: true, error: {code: 3}, readyState: 4}), false);
    assert.equal(context.media_is_ready_but_paused({paused: false, error: null, readyState: 4}), false);
});


test("blocked audible autoplay falls back only after a recent block signal", async () => {
    const {context} = loadApplication();
    let playCalls = 0;
    let muteButtonUpdates = 0;
    const player = {
        video: {
            paused: true,
            muted: false,
            volume: 0.7,
            play() {
                playCalls += 1;
                return Promise.resolve();
            }
        }
    };
    context.audio_unlocked = true;
    context.update_mute_button = () => { muteButtonUpdates += 1; };
    context.update_volume_display = () => {};

    assert.equal(context.resume_muted_after_blocked_audio(player), false);
    assert.equal(player.video.muted, false);
    assert.equal(context.audio_unlocked, true);

    player.last_audible_play_blocked_at = Date.now();
    assert.equal(context.resume_muted_after_blocked_audio(player), true);
    assert.equal(player.video.muted, true);
    assert.equal(player.video.volume, 0);
    assert.equal(context.audio_unlocked, false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(playCalls, 1);
    assert.equal(muteButtonUpdates, 1);
});


test("startup requires sustained timeline progress before becoming ready", () => {
    const {context} = loadApplication();
    const player = {startup_pending: true, startup_progress_started_at: 0};

    assert.equal(context.startup_progress_is_stable(player, 1000), false);
    assert.equal(player.startup_progress_started_at, 1000);
    assert.equal(context.startup_progress_is_stable(player, 1749), false);
    assert.equal(context.startup_progress_is_stable(player, 1750), true);

    player.startup_pending = false;
    assert.equal(context.startup_progress_is_stable(player, 5000), false);
});


test("buffered fragments cannot restart a player after startup", () => {
    const {context} = loadApplication();
    let playCalls = 0;
    const hls = {};
    const video = {
        paused: true,
        play() {
            playCalls += 1;
            return Promise.resolve();
        }
    };
    context.stream_players.example = {
        hls,
        video,
        manual_paused: false,
        resume_blocked: true,
        startup_pending: false
    };

    context.retry_hls_startup_play("example", hls, video);
    assert.equal(playCalls, 0);
    assert.equal(context.stream_players.example.resume_blocked, true);

    context.stream_players.example.startup_pending = true;
    context.retry_hls_startup_play("example", hls, video);
    assert.equal(playCalls, 1);
    assert.equal(context.stream_players.example.resume_blocked, false);
});
