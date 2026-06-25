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


test("latency sync targets the slowest natural stream plus extra buffer", () => {
    const {context, localStorage} = loadApplication();

    const target = context.calculate_latency_sync_target([
        {natural_latency: 4.2},
        {natural_latency: 6.8},
        {natural_latency: 5.1}
    ], 3);

    assert.equal(target, 9.8);
    assert.equal(context.clamp_latency_sync_delay(42), 30);
    assert.equal(context.clamp_latency_sync_delay(-2), 0);
    localStorage.setItem("multitwitch.latencySyncDelay", "7");
    assert.equal(context.load_saved_latency_sync_delay(), 7);
});


test("latency sync seeks large errors and gently corrects small drift", () => {
    const {context} = loadApplication();

    const behind = context.latency_sync_correction(10, 7, 100, 80, 120);
    assert.equal(behind.seek_to, 103);
    assert.equal(behind.playback_rate, 1);

    // Small drift inside the nudge band (between an explicit tight tolerance and
    // the seek threshold) is gently rate-corrected rather than seeked.
    const ahead = context.latency_sync_correction(6.6, 7, 100, 80, 120, 0.2);
    assert.equal(ahead.seek_to, null);
    assert.ok(ahead.playback_rate < 1 && ahead.playback_rate >= 0.9,
        "a stream that's ahead is gently slowed, not seeked");

    const aligned = context.latency_sync_correction(7.1, 7, 100, 80, 120);
    assert.equal(aligned.seek_to, null);
    assert.equal(aligned.playback_rate, 1);
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


test("latency sync uses hls timeline data when native seek ranges are unavailable", () => {
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


test("sync tolerance widens the synced dead-band and is clamped", () => {
    const {context, localStorage} = loadApplication();

    // A 0.6s drift is "synced" under a 1.0s tolerance (default would nudge it).
    const within = context.latency_sync_correction(7.6, 7, 100, 80, 120, 1.0);
    assert.equal(within.seek_to, null);
    assert.equal(within.playback_rate, 1);

    // A large gap (past tolerance + the seek margin) seeks straight to live.
    const beyond = context.latency_sync_correction(9, 7, 100, 80, 120, 1.0);
    assert.equal(beyond.seek_to, 102);
    assert.equal(beyond.playback_rate, 1);

    assert.equal(context.clamp_latency_sync_tolerance(9), 3);          // above max
    assert.equal(context.clamp_latency_sync_tolerance(0), 0.5);        // below min -> clamped up
    assert.equal(context.clamp_latency_sync_tolerance(0.74), 0.7);     // rounds to a tenth
    localStorage.setItem("multitwitch.latencySyncTolerance", "1.5");
    assert.equal(context.load_saved_latency_sync_tolerance(), 1.5);
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
