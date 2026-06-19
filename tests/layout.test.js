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

    const ahead = context.latency_sync_correction(6.6, 7, 100, 80, 120);
    assert.equal(ahead.seek_to, null);
    assert.equal(ahead.playback_rate, 0.97);

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


test("fatal hls.js playback failure sticks to native HLS on reload", () => {
    const {context} = loadApplication();
    const video = {
        canPlayType(type) {
            return type === "application/vnd.apple.mpegurl" ? "maybe" : "";
        }
    };
    context.stream_players.example = {hls: {}, video};
    context.mark_stream_stalled = () => {};
    let recoveryScheduled = false;
    context.schedule_stream_recovery = () => { recoveryScheduled = true; };

    context.handle_stream_playback_failure("example");

    assert.equal(context.stream_force_native_hls.example, true);
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
    assert.equal(diagnostics.url, "https://usher.ttvnw.net/api/channel/hls/example.m3u8");
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
