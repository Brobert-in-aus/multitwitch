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
