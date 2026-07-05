// Bump on each JS change. Rendered next to the title by the JS itself (not the
// server template), so a hard refresh always shows the version actually loaded
// -- even if the dev server cached an older home.tmpl.
var APP_VERSION = "117";
var chat_hidden = false;
var num_streams = -1;
var streams = [];
var chat_tabs;
var stream_players = {};
var stream_tile_counter = 0;
var stream_dragging = false;
var stream_drag_order = null;
var stream_drag_name = null;
var stream_drag_pointer = null;
var stream_drag_target_name = null;
var active_stream = null;
var hovered_stream = null;  // tile under the cursor, target for fullscreen / PiP
var layout_mode = "grid";
var theater_mode = false;
var feedback_open = false;
var help_open = false;
// Main-size slider positions by layout. Grid and 2-wide are fixed displays.
var main_size_fractions = {
    "focus-one": 0.70,
    "focus-two-vertical": 0.70
};
var main_size_fraction = main_size_fractions["focus-one"];
var active_border_timer = null;
var audio_unlocked = false;  // browsers block autoplay-with-sound until a gesture
var audio_restore_pending = false;
var master_volume = 0.70;
var master_muted = false;
// Per-stream audio added via Shift-click: name -> {on, volume, follows_master}.
// Each entry defaults to master volume and tracks it until its own slider is
// dragged. Not persisted; Shift-clicking off deletes the entry, so a later
// Shift-click on resets it to follow master again. Survives player reloads.
var stream_audio = {};
var is_touch_device = false;  // no hover -> reveal tile controls on tap instead
var MASTER_VOLUME_STORAGE_KEY = "multitwitch.masterVolume";
var MASTER_MUTED_STORAGE_KEY = "multitwitch.masterMuted";
var LAYOUT_MODE_STORAGE_KEY = "multitwitch.layoutMode";
var MAIN_SIZE_STORAGE_KEY = "multitwitch.mainSizeFractions";
var ACTIVE_STREAM_STORAGE_KEY = "multitwitch.activeStream";
var VALID_LAYOUT_MODES = {"grid": 1, "focus-one": 1, "focus-two": 1, "focus-two-vertical": 1};
// Below this many px of stream area, auto-collapse chat so tiles stay usable.
var MIN_STREAMS_WIDTH = 420;
var MIN_REST_HEIGHT = 80;  // keep at least a thin strip for the smaller tiles
var GRID_GAP = 4;     // must match #streams `gap` in the CSS
var TILE_CHROME = 4;  // border width jQuery adds on top of the size we set
var stream_quality_choice = {};  // name -> requested quality label, survives reloads
// Edge's native HLS path is more tolerant of some Twitch delivery failures.
// Native HLS is the primary engine (lower latency, no proxy hop) whenever the
// browser can actually play the stream. If native can't (e.g. Chromium that
// reports HLS support but can't demux Twitch's MPEG-TS), the channel is pinned
// to hls.js for subsequent reloads. Convergence steering also requires hls.js.
var stream_force_hls_js = {};
var quality_adapt_timer = null;
// Only re-pick quality once tiles have stopped resizing for this long, so
// dragging the main-size slider or a window edge doesn't thrash the players.
var QUALITY_ADAPT_DELAY = 10000;
// Convergence controller (docs/obsolete-stream-sync.md): always-on steering of
// every stream toward one shared wall-clock instant -- the slowest healthy
// channel's live-edge program-date-time minus a safe holdback. With a single
// stream the same math degenerates to "hold ~4s behind my own edge", so there
// is no mode and no toggle. Replaced the experimental latency-sync feature.
var CONVERGENCE_INTERVAL = 1000;
// Minimum holdback behind each channel's ingest edge. Normal Twitch TS streams
// are ~2s per segment, so 6s == 3 segments. Some channels emit ~4.17s segments,
// where a fixed 6s holdback is only ~1.4 segments and can sit inside the
// drip-fed frontier. The controller therefore derives a per-channel floor from
// actual fragment durations and keeps this value as the minimum for ordinary
// streams.
var CONVERGENCE_HOLDBACK = 6;
var CONVERGENCE_HOLDBACK_SEGMENTS = 3;
var CONVERGENCE_MAX_HOLDBACK = 10;
// Forward-buffer floor for rate increases. Speeding up with a thin buffer just
// drives the playhead into the delivery frontier no matter where the wall is,
// so catch-up waits until at least this much media is buffered ahead.
var CONVERGENCE_MIN_BUFFER = 3;
var CONVERGENCE_MIN_BUFFER_SEGMENTS = 1.5;
// Where a fresh stream starts, before the controller glides it onto the wall.
// Deliberately deeper than the holdback: at 8s every segment the player wants
// is complete and downloadable at wire speed, so startup is smooth (starting
// at the holdback itself put the first seconds inside the drip-fed frontier
// zone and stuttered), and the glide in is a gentle imperceptible speed-up.
var CONVERGENCE_STARTUP_LATENCY = 8;
var CONVERGENCE_STARTUP_SEGMENTS = 4;
var CONVERGENCE_MAX_STARTUP_LATENCY = 12;
var STARTUP_SYNC_COORDINATION_WINDOW = 2000;
var STARTUP_SYNC_MIN_BUFFER = 1;
// The PDT signal has no per-segment sawtooth, so the dead-band only needs to
// cover playlist fetch jitter and cross-channel ingest-timestamp skew.
var CONVERGENCE_DEADBAND = 0.3;
var CONVERGENCE_SEEK_THRESHOLD = 4;
// Asymmetric authority: catching up toward live is near-imperceptible with
// browser pitch correction; slowing the audible stream is what viewers notice.
var CONVERGENCE_MAX_SPEEDUP = 0.15;
var CONVERGENCE_MAX_SLOWDOWN = 0.05;
var CONVERGENCE_MIN_NUDGE = 0.02;
// An edge trailing the freshest by more than this is a stalled playlist, not
// the legitimate slowest pipeline -- it must not drag the shared wall back.
var CONVERGENCE_STRAGGLER_LIMIT = 10;
var CONVERGENCE_STRAGGLER_SEGMENTS = 3;
var CONVERGENCE_STRAGGLER_EXIT_MARGIN = 2;
var CONVERGENCE_STRAGGLER_ENTER_TICKS = 3;
var CONVERGENCE_STRAGGLER_EXIT_TICKS = 2;
// A channel whose PDT is minutes away from the client clock is presumed to
// have a broken clock and self-holds via the latency fallback instead.
var CONVERGENCE_PDT_SANITY_LIMIT = 300;
var CONVERGENCE_SEEK_COOLDOWN = 3000;  // ms; must exceed CONVERGENCE_INTERVAL
var convergence_timer = null;
var convergence_disabled = false;
var stream_load_pending = {};
var startup_sync_timer = null;
var sync_debug_enabled = false;
var twitch_user = null;
var followed_channels = [];
var followed_channels_loaded = false;
var follow_refresh_pending = false;
var twitch_live_channels = {};
var stream_metadata = {};
var stream_together_checked = {};
var stream_together_inflight = {};
var stream_together_results = {};
var stream_together_matches_acknowledged = false;
var chat_width_override = load_saved_chat_width();
var chat_resizing = false;
var chat_resize_grab_offset = 0;
var chat_resize_right = 0;
var usage_events_ready = false;

function initialize_usage_events() {
    usage_events_ready = true;
    initialize_client_error_events();
    track_usage_event("page_view");
}

function initialize_client_error_events() {
    window.addEventListener("error", function(event) {
        // Ignore resource-load failures and third-party script errors. These are
        // usually network/CDN/browser issues, not StreamMulti bugs.
        if (event.target && event.target !== window) {
            return;
        }
        if (event.message === "Script error.") {
            return;
        }
        if (event.filename && event.filename.indexOf("/static/js/multitwitch.js") == -1) {
            return;
        }
        track_usage_event("client_error", {
            area: "runtime",
            kind: bug_error_kind(event.error, event.message),
            detail: bug_error_detail(event.message)
        });
    });
    window.addEventListener("unhandledrejection", function(event) {
        track_usage_event("client_error", {
            area: "promise",
            kind: bug_error_kind(event.reason, ""),
            detail: bug_error_detail(event.reason && event.reason.message)
        });
    });
}

function bug_error_kind(error, message) {
    if (error && error.name) {
        return String(error.name).slice(0, 40);
    }
    message = String(message || "");
    if (message.indexOf(" is not defined") != -1) {
        return "ReferenceError";
    }
    if (message.indexOf(" is not a function") != -1) {
        return "TypeError";
    }
    return "Error";
}

function bug_error_detail(message) {
    message = String(message || "");
    if (message.indexOf(" is not defined") != -1) {
        return "undefined_reference";
    }
    if (message.indexOf(" is not a function") != -1) {
        return "not_a_function";
    }
    if (message.indexOf("Cannot read") != -1 || message.indexOf("undefined") != -1 || message.indexOf("null") != -1) {
        return "nullish_access";
    }
    if (message.indexOf("JSON") != -1) {
        return "json_parse";
    }
    return "other";
}

function track_usage_event(event_name, fields) {
    var payload = usage_event_payload(event_name, fields || {});
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
        try {
            if (navigator.sendBeacon("/api/events", new Blob([body], {type: "application/json"}))) {
                return;
            }
        } catch (e) {}
    }
    $.ajax({
        url: "/api/events",
        type: "POST",
        data: body,
        contentType: "application/json",
        timeout: 1500
    });
}

function usage_event_payload(event_name, fields) {
    var payload = {
        event: event_name,
        stream_count: streams.length,
        layout: layout_mode,
        darkmode: !!darkmode,
        theater: !!theater_mode,
        chat_hidden: !!chat_hidden,
        viewport: viewport_bucket(),
        screen: screen_bucket()
    };
    for (var key in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
            payload[key] = fields[key];
        }
    }
    return payload;
}

function viewport_bucket() {
    var width = $(window).width();
    if (width < 640) {
        return "xs";
    }
    if (width < 900) {
        return "sm";
    }
    if (width < 1280) {
        return "md";
    }
    if (width < 1800) {
        return "lg";
    }
    return "xl";
}

function screen_bucket() {
    var width = window.screen && window.screen.width ? window.screen.width : 0;
    if (width < 900) {
        return "small";
    }
    if (width < 1600) {
        return "medium";
    }
    return "large";
}

function optimize_size(n) {
    // Call with n = -1 to use previously known quantity
    if (n == -1) {
        if (num_streams == -1) {
            return;
        } else {
            n = num_streams;
        }
    } else {
        if (n == 0) {
            $("#helpbox").show();
            hide_chat();
        } else {
            $("#helpbox").hide();
            if (num_streams == 0) {
                show_chat();
                chat_tabs.tabs({ active: 0 });
            }
        }
        num_streams = n;
    }

    // Resize chat
    // height is off by 16 due to body margin
    var height = $(window).innerHeight() - 16;
    var wrapper_width = $("#watch_area").width();
    // Chat scales with the available width (narrow viewport / vertical browser
    // tabs -> slimmer chat) and auto-collapses when it would crush the streams.
    var default_chat_width = theater_mode
        ? Math.round(wrapper_width * 0.20)
        : Math.round(wrapper_width * 0.24);
    var chat_min_width = theater_mode ? 260 : 240;
    var chat_max_width = theater_mode ? 420 : 560;
    var chat_width = clamp_chat_width(chat_width_override || default_chat_width, wrapper_width, chat_min_width, chat_max_width);
    var chat_toggle_on = $("#theater_chat_toggle").prop("checked");
    var auto_hide_chat = !theater_mode && (wrapper_width - chat_width - 5) < MIN_STREAMS_WIDTH;
    var effective_chat_hidden = chat_hidden || (theater_mode && !chat_toggle_on) || auto_hide_chat;
    // Theater chat visibility is CSS-driven; manage inline display elsewhere.
    if (!theater_mode) {
        if (chat_hidden || auto_hide_chat) {
            $("#chatbox").hide();
        } else {
            $("#chatbox").show();
        }
    }
    var width;
    if(!effective_chat_hidden) {
        width = wrapper_width - chat_width - 5;
        var chat_height = height - $("#tablist").height() - 24;
        $("#streams").width(width);
        $("#chatbox").width(chat_width);
        $(".stream_chat").height(chat_height);
        // Park the theater controls just left of the chat column so they clear
        // the chat tabs (top-right) and the stream title overlay (top-left).
        document.body.style.setProperty("--theater-controls-right", (chat_width + 12) + "px");
    } else {
        width = wrapper_width;
        $("#streams").width(width);
    }

    var best_height = 0;
    var best_width = 0;
    var wrapper_padding = 0;
    for (var per_row = 1; per_row <= n; per_row++) {
        var num_rows = Math.ceil(n / per_row);
        // Budget out the flex gaps between tiles and the per-tile chrome (border
        // that ends up added on top of the width jQuery sets) so the computed
        // tiles actually fit `per_row` across instead of wrapping.
        var max_width = Math.floor((width - GRID_GAP * per_row) / per_row) - TILE_CHROME;
        var max_height = Math.floor((height - GRID_GAP * num_rows) / num_rows) - TILE_CHROME;
        if (max_width * 9/16 < max_height) {
            max_height = max_width * 9/16;
        } else {
            max_width = (max_height) * 16/9;
        }
        if (max_width > best_width) {
            best_width = max_width;
            best_height = max_height;
            wrapper_padding = Math.max(0, (height - num_rows * (max_height + GRID_GAP + TILE_CHROME)) / 2);
        }
    }
    if (layout_mode == "grid") {
        $("#focus_break").detach();
        reset_tile_positioning();
        $("#streams").height("");
        $(".stream").height(Math.floor(best_height));
        $(".stream").width(Math.floor(best_width));
        $("#streams").css("padding-top", wrapper_padding);
    } else if (layout_mode == "focus-one") {
        apply_focus_one_l_sizes(width, height);
    } else if (layout_mode == "focus-two-vertical") {
        apply_focus_two_vertical_sizes(width, height);
    } else {
        // apply_focus_layout_sizes sets its own (centered) padding-top.
        apply_focus_layout_sizes(width, height);
    }
    $("#stream_count").text(n);
    update_main_markers();
    render_current_streams();
    render_stream_together_actions();
    render_stream_together_results();
    schedule_quality_adaptation();
}

var FOCUS_GAP = GRID_GAP;

// Largest 16:9 box that fits inside box_w x box_h.
function fit_16_9(box_w, box_h) {
    var w = box_w;
    var h = Math.floor(w * 9 / 16);
    if (h > box_h) {
        h = box_h;
        w = Math.floor(h * 16 / 9);
    }
    return {w: Math.max(0, w), h: Math.max(0, h)};
}

// Largest equal 16:9 tile that fits n tiles into width x height, trying every
// "tiles per row" split (same idea as the grid optimizer).
function best_grid_size(n, width, height) {
    var best = {w: 0, h: 0, rows: 1};
    for (var per_row = 1; per_row <= n; per_row++) {
        var rows = Math.ceil(n / per_row);
        var box_w = Math.floor((width - FOCUS_GAP * per_row) / per_row) - TILE_CHROME;
        var box_h = Math.floor((height - FOCUS_GAP * rows) / rows) - TILE_CHROME;
        if (box_w <= 0 || box_h <= 0) {
            continue;
        }
        var size = fit_16_9(box_w, box_h);
        if (size.w > best.w) {
            best = {w: size.w, h: size.h, rows: rows};
        }
    }
    return best;
}

function grid_columns_for_size(n, area_w, tile_w) {
    if (n <= 0 || tile_w <= 0) {
        return 0;
    }
    return Math.max(1, Math.min(n, Math.floor((area_w + FOCUS_GAP) / (tile_w + TILE_CHROME + FOCUS_GAP))));
}

function grid_metrics_for_size(n, area_w, tile_w, tile_h) {
    var cols = grid_columns_for_size(n, area_w, tile_w);
    var rows = cols > 0 ? Math.ceil(n / cols) : 0;
    var block_w = cols > 0 ? cols * (tile_w + TILE_CHROME) + (cols - 1) * FOCUS_GAP : 0;
    var block_h = rows > 0 ? rows * (tile_h + TILE_CHROME) + (rows - 1) * FOCUS_GAP : 0;
    return {cols: cols, rows: rows, block_w: block_w, block_h: block_h};
}

function capped_grid_size(n, area_w, area_h, cap_w, cap_h) {
    if (n <= 0) {
        return {w: 0, h: 0, rows: 0};
    }
    var size = best_grid_size(n, area_w, area_h);
    if (size.w > cap_w || size.h > cap_h) {
        size = fit_16_9(Math.min(size.w, cap_w), Math.min(size.h, cap_h));
    }
    var metrics = grid_metrics_for_size(n, area_w, size.w, size.h);
    size.rows = metrics.rows;
    return size;
}

function reset_tile_positioning() {
    $("#streams .stream").css({
        left: "",
        position: "",
        top: ""
    });
}

// Focus layouts: 1 or 2 equally-sized mains across the top, the rest maximized
// in a strip below. main_size_fraction (the "Main size" slider) sets how much of
// the height the mains get. A zero-height flex break forces the smaller tiles
// onto their own row(s) regardless of how wide the mains end up.
function apply_focus_layout_sizes(width, height) {
    var tiles = $("#streams .stream");
    var brk = ensure_focus_break();
    reset_tile_positioning();
    $("#streams").height("");
    if (tiles.length == 0) {
        brk.detach();
        return;
    }

    var main_count = Math.min(main_tile_count(), tiles.length);
    if (main_count < 1) {
        main_count = 1;
    }
    var rest_count = tiles.length - main_count;

    if (rest_count > 0) {
        brk.insertAfter(tiles.eq(main_count - 1));
    } else {
        brk.appendTo("#streams");
    }

    var main_slot_w = Math.floor((width - FOCUS_GAP * main_count) / main_count) - TILE_CHROME;
    // The largest a main can be is width-bound (its 16:9 height at full slot
    // width), also capped so a rest strip still fits. The slider's 100% maps to
    // exactly this -- past it the main can't grow, so there's nothing to add.
    var main_wb_h = Math.floor(main_slot_w * 9 / 16);
    var max_main_h = rest_count > 0
        ? Math.min(main_wb_h, height - FOCUS_GAP - MIN_REST_HEIGHT)
        : Math.min(main_wb_h, height);
    max_main_h = Math.max(max_main_h, 80);
    var min_main_h = Math.min(max_main_h, Math.round(max_main_h * 0.5));
    var pos = layout_mode == "focus-two" ? 1.0 : (rest_count > 0 ? main_size_fraction : 1.0);
    var main_band_h = Math.round(min_main_h + pos * (max_main_h - min_main_h));

    var main_size = fit_16_9(main_slot_w, main_band_h);
    // Rest always fills the ACTUAL leftover height, so the main growing/shrinking
    // never leaves an empty band -- it just trades space with the rest strip.
    var rest_area_h = Math.max(height - main_size.h - TILE_CHROME - FOCUS_GAP, 0);
    var rest_size = rest_count > 0 ? best_grid_size(rest_count, width, rest_area_h) : {w: 0, h: 0, rows: 0};
    if (rest_size.w > main_size.w || rest_size.h > main_size.h) {
        rest_size = fit_16_9(Math.min(rest_size.w, main_size.w), Math.min(rest_size.h, main_size.h));
        rest_size.rows = Math.max(1, Math.ceil(rest_count / grid_columns_for_size(rest_count, width, rest_size.w)));
    }

    tiles.each(function(index) {
        var tile = $(this);
        if (index < main_count) {
            tile.width(main_size.w).height(main_size.h);
        } else {
            tile.width(rest_size.w).height(rest_size.h);
        }
    });

    // Vertically center the actual content so a width-bound main (which can't use
    // its whole allotted band) doesn't leave a lopsided gap.
    var main_block = main_size.h + TILE_CHROME;
    var rest_block = rest_count > 0
        ? rest_size.rows * (rest_size.h + TILE_CHROME) + (rest_size.rows - 1) * FOCUS_GAP
        : 0;
    var used = main_block + (rest_count > 0 ? FOCUS_GAP + rest_block : 0);
    $("#streams").css("padding-top", Math.max(0, (height - used) / 2));
}

function ensure_focus_break() {
    var brk = $("#focus_break");
    if (brk.length == 0) {
        brk = $("<div>", {id: "focus_break"});
    }
    return brk;
}

function apply_focus_one_l_sizes(width, height) {
    var tiles = $("#streams .stream");
    $("#focus_break").detach();
    if (tiles.length == 0) {
        return;
    }

    var rest_count = tiles.length - 1;
    var max_main_h = rest_count > 0
        ? Math.max(80, height - FOCUS_GAP - MIN_REST_HEIGHT)
        : height;
    var max_main_size = fit_16_9(width - TILE_CHROME, max_main_h);
    var min_main_w = Math.min(max_main_size.w, Math.max(160, Math.round(max_main_size.w * 0.45)));
    var main_w = rest_count > 0
        ? Math.round(min_main_w + main_size_fraction * (max_main_size.w - min_main_w))
        : max_main_size.w;
    var main_size = fit_16_9(main_w, max_main_h);
    var right_x = main_size.w + TILE_CHROME + FOCUS_GAP;
    var right_w = Math.max(0, width - right_x);
    var main_block_h = main_size.h + TILE_CHROME;
    var layout = best_l_rest_layout(rest_count, width, height, right_x, right_w, main_block_h, main_size);
    var main_x = layout.right.count > 0
        ? 0
        : Math.max(0, Math.floor((width - main_size.w - TILE_CHROME) / 2));

    $("#streams").height(height).css("padding-top", 0);
    tiles.each(function(index) {
        var tile = $(this);
        tile.css("position", "absolute");
        if (index == 0) {
            tile.width(main_size.w).height(main_size.h).css({
                left: main_x,
                top: layout.main_y
            });
            return;
        }
        var rest_index = index - 1;
        var zone = layout.bottom;
        var zone_index = rest_index - layout.right.count;
        if (rest_index < layout.right.count) {
            zone = layout.right;
            zone_index = rest_index;
        }
        var col = zone.cols > 0 ? zone_index % zone.cols : 0;
        var row = zone.cols > 0 ? Math.floor(zone_index / zone.cols) : 0;
        tile.width(layout.size.w).height(layout.size.h).css({
            left: zone.x + col * (layout.size.w + TILE_CHROME + FOCUS_GAP),
            top: zone.y + row * (layout.size.h + TILE_CHROME + FOCUS_GAP)
        });
    });
}

function apply_focus_two_vertical_sizes(width, height) {
    var tiles = $("#streams .stream");
    $("#focus_break").detach();
    if (tiles.length == 0) {
        return;
    }
    var main_count = Math.min(2, tiles.length);
    var rest_count = tiles.length - main_count;
    var pos = main_size_fractions["focus-two-vertical"];
    var max_stack_h = Math.floor((height - FOCUS_GAP - TILE_CHROME * main_count) / main_count);
    var max_stack_w = Math.floor(max_stack_h * 16 / 9);
    if (rest_count > 0) {
        max_stack_w = Math.min(max_stack_w, Math.max(120, width - MIN_STREAMS_WIDTH));
    } else {
        max_stack_w = Math.min(max_stack_w, width);
    }
    var min_stack_w = Math.max(160, Math.round(max_stack_w * 0.45));
    var main_w = Math.round(min_stack_w + pos * (max_stack_w - min_stack_w));
    var main_size = fit_16_9(main_w, max_stack_h);
    var left_w = main_size.w + TILE_CHROME;
    var right_x = left_w + FOCUS_GAP;
    var right_w = Math.max(0, width - right_x);
    var main_stack_h = main_count * (main_size.h + TILE_CHROME) + (main_count - 1) * FOCUS_GAP;
    var layout = best_l_rest_layout(rest_count, width, height, right_x, right_w, main_stack_h, main_size);
    var main_y = layout.main_y;

    $("#streams").height(height).css("padding-top", 0);
    tiles.each(function(index) {
        var tile = $(this);
        tile.css("position", "absolute");
        if (index < main_count) {
            tile.width(main_size.w).height(main_size.h).css({
                left: 0,
                top: main_y + index * (main_size.h + TILE_CHROME + FOCUS_GAP)
            });
            return;
        }
        var rest_index = index - main_count;
        var zone = layout.bottom;
        var zone_index = rest_index - layout.right.count;
        if (rest_index < layout.right.count) {
            zone = layout.right;
            zone_index = rest_index;
        }
        var col = zone.cols > 0 ? zone_index % zone.cols : 0;
        var row = zone.cols > 0 ? Math.floor(zone_index / zone.cols) : 0;
        tile.width(layout.size.w).height(layout.size.h).css({
            left: zone.x + col * (layout.size.w + TILE_CHROME + FOCUS_GAP),
            top: zone.y + row * (layout.size.h + TILE_CHROME + FOCUS_GAP)
        });
    });
}

function best_l_rest_layout(rest_count, width, height, right_x, right_w, main_stack_h, main_size) {
    var empty_zone = {count: 0, cols: 0, rows: 0, x: 0, y: 0, block_w: 0, block_h: 0};
    if (rest_count <= 0) {
        return {
            size: {w: 0, h: 0},
            main_y: Math.max(0, Math.floor((height - main_stack_h) / 2)),
            right: empty_zone,
            bottom: empty_zone
        };
    }

    var best = null;
    for (var right_count = 0; right_count <= rest_count; right_count++) {
        var bottom_count = rest_count - right_count;
        var top_gap = bottom_count > 0 ? FOCUS_GAP : 0;
        var bottom_area_h = Math.max(0, height - main_stack_h - top_gap);
        if (bottom_count > 0 && bottom_area_h <= 0) {
            continue;
        }

        var right_size = right_count > 0
            ? capped_grid_size(right_count, right_w, main_stack_h, main_size.w, main_size.h)
            : {w: main_size.w, h: main_size.h};
        var bottom_size = bottom_count > 0
            ? capped_grid_size(bottom_count, width, bottom_area_h, main_size.w, main_size.h)
            : {w: main_size.w, h: main_size.h};
        if ((right_count > 0 && right_size.w <= 0) || (bottom_count > 0 && bottom_size.w <= 0)) {
            continue;
        }

        var tile_size = fit_16_9(
            Math.min(main_size.w, right_size.w, bottom_size.w),
            Math.min(main_size.h, right_size.h, bottom_size.h)
        );
        if (tile_size.w <= 0 || tile_size.h <= 0) {
            continue;
        }

        var right_metrics = right_count > 0
            ? grid_metrics_for_size(right_count, right_w, tile_size.w, tile_size.h)
            : empty_zone;
        var bottom_metrics = bottom_count > 0
            ? grid_metrics_for_size(bottom_count, width, tile_size.w, tile_size.h)
            : empty_zone;
        if (right_count > 0 && (right_metrics.block_w > right_w || right_metrics.block_h > main_stack_h)) {
            continue;
        }
        if (bottom_count > 0 && (bottom_metrics.block_w > width || bottom_metrics.block_h > bottom_area_h)) {
            continue;
        }

        var used_h = main_stack_h + (bottom_count > 0 ? FOCUS_GAP + bottom_metrics.block_h : 0);
        var candidate = {
            size: tile_size,
            score: tile_size.w * tile_size.h,
            right_count: right_count,
            bottom_count: bottom_count,
            used_h: used_h,
            right_metrics: right_metrics,
            bottom_metrics: bottom_metrics
        };
        if (!best || candidate.score > best.score || (candidate.score == best.score && candidate.right_count > best.right_count)) {
            best = candidate;
        }
    }

    if (!best) {
        best = {
            size: {w: 0, h: 0},
            right_count: 0,
            bottom_count: 0,
            used_h: main_stack_h,
            right_metrics: empty_zone,
            bottom_metrics: empty_zone
        };
    }

    var group_y = Math.max(0, Math.floor((height - best.used_h) / 2));
    var right_x_offset = best.right_metrics.block_w > 0
        ? right_x + Math.max(0, Math.floor((right_w - best.right_metrics.block_w) / 2))
        : right_x;
    var right_y = group_y + Math.max(0, Math.floor((main_stack_h - best.right_metrics.block_h) / 2));
    var bottom_y = group_y + main_stack_h + (best.bottom_count > 0 ? FOCUS_GAP : 0);
    var bottom_x = best.bottom_metrics.block_w > 0
        ? Math.max(0, Math.floor((width - best.bottom_metrics.block_w) / 2))
        : 0;

    return {
        size: best.size,
        main_y: group_y,
        right: {
            count: best.right_count,
            cols: best.right_metrics.cols,
            rows: best.right_metrics.rows,
            x: right_x_offset,
            y: right_y,
            block_w: best.right_metrics.block_w,
            block_h: best.right_metrics.block_h
        },
        bottom: {
            count: best.bottom_count,
            cols: best.bottom_metrics.cols,
            rows: best.bottom_metrics.rows,
            x: bottom_x,
            y: bottom_y,
            block_w: best.bottom_metrics.block_w,
            block_h: best.bottom_metrics.block_h
        }
    };
}

function absolute_center(object) {
    var window_height = $(window).height();
    var window_width = $(window).innerWidth();
    var obj_height = object.height();
    var obj_width = object.width();
    var pos_x = (window_width - obj_width)/2;
    var pos_y = (window_height - obj_height)/2;
    if (pos_x < 0) {
        pos_x = 0;
    }
    if (pos_y < 0) {
        pos_y = 0;
    }
    object.css('position', 'absolute');
    object.css('left', pos_x);
    object.css('top', pos_y);
}

function hide_chat() {
    chat_hidden = true;
    $("#chatbox").hide();
    optimize_size(-1);
}

function show_chat() {
    chat_hidden = false;
    $("#chatbox").show();
    optimize_size(-1);
}

function toggle_chat() {
    if (chat_hidden) {
        show_chat();
    } else {
        hide_chat();
    }
    track_usage_event("chat_toggled");
}

function submit_add_stream() {
    var input = $("#add_stream_input");
    if (add_stream(input.val())) {
        input.val("");
    }
    input.focus();
}

function add_stream_keyup(e) {
    if (e.keyCode == 13 || e.which == 13) {
        submit_add_stream();
        return false;
    }
    return true;
}

function remove_stream(name) {
    var idx = streams.indexOf(name);
    if (idx == -1) {
        return;
    }
    if (stream_together_inflight[name] && stream_together_inflight[name].abort) {
        stream_together_inflight[name].abort();
    }
    delete stream_together_inflight[name];
    delete stream_together_checked[name];
    delete stream_together_results[name];
    delete stream_quality_choice[name];
    delete stream_audio[name];
    stream_tile_by_name(name).remove();
    $("#chat-" + name).remove();
    $("#tablist a[href='#chat-" + name + "']").closest("li").remove();
    destroy_stream_player(name);
    streams.splice(idx, 1);
    if (active_stream == name) {
        active_stream = streams.length ? streams[0] : null;
    }
    if (chat_tabs) {
        chat_tabs.tabs("refresh");
    }
    reorder_chat_for_streams();
    update_url();
    sync_active_stream_audio();
    optimize_size(streams.length);
    render_followed_channels();
    render_presets();
    load_current_stream_metadata();
    track_usage_event("stream_removed");
}

function chat_src(name) {
    // darkpopout = Twitch's dark-theme chat embed (matches the dark UI).
    return "https://www.twitch.tv/embed/" + encodeURIComponent(name) + "/chat?" + twitch_parent_query + "&darkpopout";
}

function stream_object(name) {
    var tile_id = next_stream_tile_id();
    return $("<div>", {
        id: tile_id,
        "class": "stream",
        "data-stream": name
    }).append($("<div>", {
        id: tile_id + "_player",
        "class": "stream_player"
    })).append($("<div>", {
        "class": "stream_hitbox",
        role: "button",
        tabindex: 0,
        "aria-label": "Make " + name + " the active audio stream"
    })).append($("<button>", {
        type: "button",
        "class": "stream_playback_button",
        "aria-label": "Pause " + name,
        title: "Pause",
        text: "\u275A\u275A"
    }).on("click", function(event) {
        toggle_stream_playback(name, event);
    })).append($("<button>", {
        type: "button",
        "class": "stream_live_button",
        "aria-label": "Jump to live edge for " + name,
        title: "Jump to live",
        text: "⟳"
    }).on("click", function(event) {
        sync_to_live(name, event);
    })).append($("<div>", {
        "class": "stream_overlay stream_title",
        text: name
    })).append($("<div>", {
        "class": "stream_overlay stream_channel",
        text: name
    })).append($("<div>", {
        "class": "stream_overlay stream_game"
    })).append(stream_audio_control(name));
}

// Per-stream volume control, hidden until the stream is Shift-click unmuted
// (tile gets .has_audio). Handlers are bound in create_stream_player so the
// static (template-rendered) tiles get them too.
function stream_audio_control(name) {
    return $("<div>", {"class": "stream_audio"})
        .append($("<button>", {
            type: "button",
            "class": "stream_audio_mute",
            "aria-label": "Mute " + name,
            title: "Mute this stream",
            text: "🔊"
        }))
        .append($("<input>", {
            type: "range",
            "class": "stream_audio_slider",
            min: 0,
            max: 100,
            value: 70,
            "aria-label": name + " volume"
        }));
}

function chat_object(name) {
    return $("<div>", {
        id: "chat-" + name,
        "class": "stream_chat"
    }).append($("<iframe>", {
        frameborder: 0,
        scrolling: "no",
        id: "chat-" + name + "-embed",
        src: chat_src(name),
        height: "100%",
        width: "100%"
    }));
}

function chat_tab_object(name) {
    return $("<li>").append($("<a>", {
        href: "#chat-" + name,
        text: name
    }));
}

function next_stream_tile_id() {
    stream_tile_counter += 1;
    return "tile_dynamic_" + stream_tile_counter;
}

function initialize_stream_players() {
    stream_tile_counter = $("#streams .stream").length;
    var saved_active = load_saved_active_stream();
    active_stream = (saved_active && streams.indexOf(saved_active) != -1)
        ? saved_active
        : (streams.length ? streams[0] : null);
    $("#streams .stream").each(function() {
        var tile = $(this);
        if (!tile.attr("id")) {
            tile.attr("id", next_stream_tile_id());
        }
        create_stream_player(tile);
    });
    sync_active_stream_audio();
    initialize_convergence();
}

function create_stream_player(tile) {
    var name = tile.attr("data-stream");
    if (tile.find(".stream_latency").length === 0) {
        $("<div>", {"class": "stream_latency", "aria-hidden": "true"}).appendTo(tile);
    }
    tile.find(".stream_hitbox").off("click.stream keydown.stream")
        .on("click.stream", function(e) {
            if (stream_dragging) {
                return;
            }
            // Shift-click adds/removes this stream's own audio; plain click sets
            // the single master-controlled audio source.
            if (e.shiftKey) {
                toggle_stream_audio(name, e);
                return;
            }
            set_active_stream(name);
            // Touch has no hover, so a tap also surfaces the tile's controls.
            reveal_tile_controls(tile);
        })
        .on("keydown.stream", function(e) {
            // The hitbox advertises role="button" -- honor Enter/Space activation.
            if (e.key === "Enter" || e.key === " " || e.keyCode === 13 || e.keyCode === 32) {
                e.preventDefault();
                if (e.shiftKey) {
                    toggle_stream_audio(name, e);
                } else {
                    set_active_stream(name);
                }
            }
        });
    tile.find(".stream_audio_slider").off("input.audio").on("input.audio", function(e) {
        e.stopPropagation();
        set_stream_volume(name, this.value);
    });
    tile.find(".stream_audio_mute").off("click.audio").on("click.audio", function(e) {
        toggle_stream_audio(name, e);
    });
    tile.attr("data-muted", "true");
    tile.find(".stream_player").empty().append(direct_player_element(name));
    update_stream_tile_metadata(tile);
    update_stream_audio_ui(name);
    load_direct_stream(tile, name);
}

function create_player_for_tile(tile) {
    create_stream_player(tile);
    sync_active_stream_audio();
    load_current_stream_metadata();
}

function update_all_stream_tile_metadata() {
    stream_tiles_for_state().each(function() {
        update_stream_tile_metadata($(this));
    });
}

function update_stream_tile_metadata(tile) {
    var name = tile.attr("data-stream") || "";
    var key = name.toLowerCase();
    var metadata = stream_metadata[key] || twitch_live_channels[key] || {};
    tile.find(".stream_title").text(metadata.title || name);
    tile.find(".stream_channel").text(metadata.user_name || metadata.display_name || name);
    tile.find(".stream_game").text(metadata.game_name || "");
}

function load_current_stream_metadata() {
    if (streams.length == 0) {
        update_all_stream_tile_metadata();
        return;
    }
    if (!twitch_user) {
        load_public_stream_metadata();
        return;
    }
    twitch_api("streams", {user_login: streams, first: 100}, function(data) {
        cache_stream_metadata(data.data || []);
        update_all_stream_tile_metadata();
    }, function() {
        load_public_stream_metadata();
    });
}

function load_public_stream_metadata() {
    if (streams.length == 0) {
        update_all_stream_tile_metadata();
        return;
    }
    $.ajax({
        url: "/api/twitch/public-streams",
        data: {user_login: streams},
        traditional: true,
        success: function(data) {
            cache_stream_metadata(data.data || []);
            update_all_stream_tile_metadata();
        },
        error: function() {
            update_all_stream_tile_metadata();
        }
    });
}

function cache_stream_metadata(live) {
    for (var i = 0; i < (live || []).length; i++) {
        if (live[i].user_login) {
            stream_metadata[live[i].user_login.toLowerCase()] = live[i];
        }
    }
}

function set_active_stream(name) {
    if (!name) {
        return;
    }
    unlock_audio();
    save_active_stream(name);
    if (active_stream == name) {
        sync_active_stream_audio();
        mark_active_audio_source();
        return;
    }
    active_stream = name;
    sync_active_stream_audio();
    mark_active_audio_source();
    setTimeout(sync_active_stream_audio, 300);
    render_current_streams();
}

function mark_active_audio_source() {
    clearTimeout(active_border_timer);
    var tile = stream_tile_by_name(active_stream);
    tile.addClass("active_fresh");
    active_border_timer = setTimeout(function() {
        stream_tile_by_name(active_stream).removeClass("active_fresh");
    }, 3200);
}

function initialize_audio_unlock() {
    $(document).on("click.audio keydown.audio", function() {
        if (stream_dragging) {
            return;
        }
        unlock_audio();
    });
}

function initialize_audio_settings() {
    try {
        var saved_volume = window.localStorage.getItem(MASTER_VOLUME_STORAGE_KEY);
        var saved_muted = window.localStorage.getItem(MASTER_MUTED_STORAGE_KEY);
        if (saved_volume !== null) {
            var parsed_volume = parseFloat(saved_volume);
            if (!isNaN(parsed_volume)) {
                master_volume = Math.max(0, Math.min(1, parsed_volume));
            }
        }
        if (saved_muted !== null) {
            master_muted = saved_muted === "true";
        }
    } catch (e) {}

    // Restore an explicitly unmuted saved state and let the browser decide
    // whether sound autoplay is permitted for this origin. safe_play() falls
    // back to muted playback and re-locks audio on NotAllowedError, preserving
    // the first-click unlock path in stricter browsers.
    audio_unlocked = saved_audio_should_start_unlocked(master_muted);
    audio_restore_pending = audio_unlocked;
    update_volume_display();
    update_mute_button();
}

function saved_audio_should_start_unlocked(saved_muted) {
    return !saved_muted;
}

function remember_unmuted_audio_state() {
    master_muted = false;
    if (master_volume <= 0) {
        master_volume = 0.70;
    }
    persist_audio_settings();
}

function persist_audio_settings() {
    try {
        window.localStorage.setItem(MASTER_VOLUME_STORAGE_KEY, String(master_volume));
        window.localStorage.setItem(MASTER_MUTED_STORAGE_KEY, String(master_muted));
    } catch (e) {}
}

// View state (layout mode, per-layout main size, audio source) is persisted to
// localStorage so a refresh restores the deck instead of snapping back to Grid.
// Tile order is not stored here -- it already round-trips through the URL.
function load_saved_layout_mode() {
    try {
        var saved = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
        if (saved && VALID_LAYOUT_MODES[saved]) {
            return saved;
        }
    } catch (e) {}
    return "grid";
}

function save_layout_mode(mode) {
    try {
        window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, mode);
    } catch (e) {}
}

function load_saved_main_size_fractions() {
    try {
        var parsed = JSON.parse(window.localStorage.getItem(MAIN_SIZE_STORAGE_KEY) || "null");
        if (!parsed) {
            return;
        }
        for (var key in main_size_fractions) {
            if (Object.prototype.hasOwnProperty.call(main_size_fractions, key) &&
                typeof parsed[key] === "number" && parsed[key] >= 0 && parsed[key] <= 1) {
                main_size_fractions[key] = parsed[key];
            }
        }
    } catch (e) {}
}

function save_main_size_fractions() {
    try {
        window.localStorage.setItem(MAIN_SIZE_STORAGE_KEY, JSON.stringify(main_size_fractions));
    } catch (e) {}
}

function load_saved_active_stream() {
    try {
        return window.localStorage.getItem(ACTIVE_STREAM_STORAGE_KEY);
    } catch (e) {
        return null;
    }
}

function save_active_stream(name) {
    if (!name) {
        return;
    }
    try {
        window.localStorage.setItem(ACTIVE_STREAM_STORAGE_KEY, name);
    } catch (e) {}
}

function unlock_audio() {
    audio_restore_pending = false;
    // A document-level click/keydown calls this on every interaction to lift the
    // browser's autoplay lock. Once audio is already unlocked it must be a no-op:
    // forcing the unmuted state here would override an explicit master mute (and,
    // because of the early return, leave the icon/readout showing the stale
    // state) -- which is exactly what broke "click anywhere re-mutes" and the
    // mute-button toggle. Only clear the mute and restore volume when we are
    // genuinely transitioning out of the locked state.
    if (audio_unlocked) {
        return;
    }
    audio_unlocked = true;
    remember_unmuted_audio_state();
    update_mute_button();
    update_volume_display();
    sync_active_stream_audio();
}

// Saved lineups: a localStorage list of {name, streams}. Loading one reconciles
// the current lineup to the preset (keeping shared tiles) rather than reloading.
var PRESETS_STORAGE_KEY = "multitwitch.presets";

function load_presets() {
    try {
        var parsed = JSON.parse(window.localStorage.getItem(PRESETS_STORAGE_KEY) || "[]");
        if (Array.isArray(parsed)) {
            return parsed.filter(function(p) {
                return p && typeof p.name === "string" && Array.isArray(p.streams);
            });
        }
    } catch (e) {}
    return [];
}

function save_presets(presets) {
    try {
        window.localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
    } catch (e) {}
}

function preset_name_keyup(e) {
    if (e.keyCode == 13 || e.which == 13) {
        save_current_preset();
        return false;
    }
    return true;
}

function save_current_preset() {
    var input = $("#preset_name_input");
    var name = $.trim(input.val());
    if (!name || streams.length === 0) {
        return;
    }
    var presets = load_presets().filter(function(p) {
        return p.name.toLowerCase() !== name.toLowerCase();
    });
    presets.push({name: name, streams: streams.slice()});
    presets.sort(function(a, b) {
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    save_presets(presets);
    input.val("");
    render_presets();
}

function remove_preset(name) {
    save_presets(load_presets().filter(function(p) {
        return p.name !== name;
    }));
    render_presets();
}

function load_preset(target) {
    var valid = [];
    for (var i = 0; i < target.length; i++) {
        var channel = $.trim(target[i]).toLowerCase();
        if (/^[a-z0-9_]{1,25}$/.test(channel) && valid.indexOf(channel) == -1) {
            valid.push(channel);
        }
    }
    if (!valid.length) {
        return;
    }
    streams.slice().forEach(function(name) {
        if (valid.indexOf(name) == -1) {
            remove_stream(name);
        }
    });
    valid.forEach(function(name) {
        if (streams.indexOf(name) == -1) {
            add_stream(name);
        }
    });
    reorder_stream_tiles(valid);
    sync_stream_order_from_dom();
    render_presets();
}

function render_presets() {
    var list = $("#presets_list");
    if (list.length === 0) {
        return;
    }
    list.empty();
    var presets = load_presets();
    if (!presets.length) {
        list.append($("<div>", {"class": "empty_state"}).text("No saved presets."));
        return;
    }
    var current_key = streams.slice().sort().join("/");
    presets.forEach(function(preset) {
        var is_current = preset.streams.slice().sort().join("/") === current_key;
        var item = $("<div>", {"class": "current_stream preset_item"}).toggleClass("is_active", is_current);
        item.append($("<span>", {
            "class": "current_stream_name",
            title: preset.streams.join(", "),
            text: preset.name + " (" + preset.streams.length + ")"
        }).click(function() {
            load_preset(preset.streams);
        }));
        item.append($("<button>", {
            type: "button",
            "class": "remove_stream",
            "aria-label": "Delete preset " + preset.name,
            title: "Delete preset",
            text: "×"
        }).click(function() {
            remove_preset(preset.name);
        }));
        list.append(item);
    });
}

// Resolve a stream's target {muted, volume}. A Shift-click stream uses its own
// volume (following master until its slider is dragged) and is independent of
// master mute. Otherwise the single active stream plays at master volume.
function stream_audio_target(name) {
    var audio = stream_audio[name];
    if (audio && audio.on) {
        var volume = audio.follows_master ? master_volume : audio.volume;
        return {muted: !audio_unlocked || volume <= 0, volume: volume};
    }
    if (name == active_stream) {
        return {
            muted: !(audio_unlocked && !master_muted && master_volume > 0),
            volume: master_volume
        };
    }
    return {muted: true, volume: 0};
}

function sync_active_stream_audio() {
    if (!active_stream && streams.length) {
        active_stream = streams[0];
    }
    $("#streams .stream").each(function() {
        var tile = $(this);
        var name = tile.attr("data-stream");
        var is_active = name == active_stream;
        var target = stream_audio_target(name);
        tile.toggleClass("is_active", is_active);
        if (!is_active) {
            tile.removeClass("active_fresh");
        }
        if (stream_players[name] && stream_players[name].video) {
            var player = stream_players[name];
            tile.attr("data-muted", target.muted ? "true" : "false");
            if (player.manual_paused) {
                set_video_muted(player.video, target.muted);
                player.video.volume = target.muted ? 0.0 : target.volume;
            } else if (player.startup_pending && target.muted) {
                set_video_muted(player.video, true);
                player.video.volume = 0.0;
                safe_play(player.video);
            } else {
                apply_video_audio(player.video, !target.muted, target.volume);
            }
        }
    });
}

// Shift-click toggle: add the stream's own audio (defaulting to follow master)
// or remove it. Removing deletes the entry so re-adding resets to follow master.
function toggle_stream_audio(name, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    unlock_audio();
    var audio = stream_audio[name];
    if (audio && audio.on) {
        delete stream_audio[name];
    } else {
        stream_audio[name] = {on: true, volume: master_volume, follows_master: true};
    }
    update_stream_audio_ui(name);
    sync_active_stream_audio();
}

function set_stream_volume(name, value) {
    var audio = stream_audio[name];
    if (!audio || !audio.on) {
        return;
    }
    var pct = parseInt(value, 10);
    if (isNaN(pct)) {
        return;
    }
    audio.volume = Math.max(0, Math.min(100, pct)) / 100;
    audio.follows_master = false;  // a dragged slider stops tracking master
    update_stream_audio_ui(name);
    sync_active_stream_audio();
}

function update_stream_audio_ui(name) {
    var tile = stream_tile_by_name(name);
    var audio = stream_audio[name];
    var on = !!(audio && audio.on);
    tile.toggleClass("has_audio", on);
    if (on) {
        var volume = audio.follows_master ? master_volume : audio.volume;
        tile.find(".stream_audio_slider").val(Math.round(volume * 100));
        tile.find(".stream_audio_mute").attr("aria-label", "Mute " + name);
    }
}

// When master volume moves, slide along any per-stream controls still following
// it (the audio itself already reads master_volume in sync_active_stream_audio).
function propagate_master_volume_to_following() {
    for (var name in stream_audio) {
        if (Object.prototype.hasOwnProperty.call(stream_audio, name) &&
            stream_audio[name].on && stream_audio[name].follows_master) {
            update_stream_audio_ui(name);
        }
    }
}

function direct_player_element(name) {
    return $("<video>", {
        "class": "direct_player",
        autoplay: true,
        playsinline: true,
        preload: "auto",
        "data-stream": name
    });
}

// Parse a Twitch quality label ("720p", "1080p60") into resolution height and
// frame rate. Non-video renditions ("audio_only") return null and are skipped.
function quality_metrics(label) {
    var match = /^(\d+)p(\d+)?$/.exec(label);
    if (!match) {
        return null;
    }
    return {label: label, height: parseInt(match[1], 10), fps: match[2] ? parseInt(match[2], 10) : 30};
}

// Smallest rendition that still covers needed_height device-pixels; if none is
// tall enough, the largest available. Ties on height prefer the lower frame
// rate (less load) -- the pixel count is what we're matching, not smoothness.
function pick_quality_for_height(qualities, needed_height) {
    var video = [];
    for (var i = 0; i < (qualities || []).length; i++) {
        var metrics = quality_metrics(qualities[i]);
        if (metrics) {
            video.push(metrics);
        }
    }
    if (!video.length) {
        return "best";
    }
    video.sort(function(a, b) {
        return a.height - b.height || a.fps - b.fps;
    });
    for (var j = 0; j < video.length; j++) {
        if (video[j].height >= needed_height) {
            return video[j].label;
        }
    }
    return video[video.length - 1].label;
}

function schedule_quality_adaptation() {
    if (quality_adapt_timer) {
        clearTimeout(quality_adapt_timer);
    }
    quality_adapt_timer = setTimeout(adapt_stream_qualities, QUALITY_ADAPT_DELAY);
}

// After tiles settle, match each stream's rendition to the pixels it's actually
// drawn at (CSS px x devicePixelRatio -- so a 4K display naturally pulls higher
// quality). Only reloads a tile when its target rendition actually changes.
function adapt_stream_qualities() {
    if (!page_active()) {
        return;
    }
    var dpr = window.devicePixelRatio || 1;
    var only_stream = $("#streams .stream").length <= 1;
    for (var name in stream_players) {
        if (!Object.prototype.hasOwnProperty.call(stream_players, name)) {
            continue;
        }
        var player = stream_players[name];
        if (!player || !player.video || !player.qualities || !player.qualities.length) {
            continue;
        }
        if (player.manual_paused || player.recovering) {
            continue;
        }
        var tile = stream_tile_by_name(name);
        // The main (focus) tile and a lone stream are the focus of attention and
        // big enough to deserve full resolution -- never downgrade them. If one
        // was shrunk while in the rest strip and then promoted, pull it back up.
        if (only_stream || tile.hasClass("is_main")) {
            if (stream_quality_choice[name] && stream_quality_choice[name] !== "best") {
                stream_quality_choice[name] = "best";
                load_direct_stream(tile, name, true, "best");
            }
            continue;
        }
        var rendered_height = player.video.clientHeight;
        if (!rendered_height) {
            continue;
        }
        var target = pick_quality_for_height(player.qualities, Math.round(rendered_height * dpr));
        if (target === "best" || target === player.quality) {
            continue;
        }
        stream_quality_choice[name] = target;
        load_direct_stream(tile, name, true, target);
    }
}

function load_direct_stream(tile, name, force_refresh, quality) {
    var video = tile.find("video.direct_player").get(0);
    if (!video) {
        return;
    }
    // Reloads (recovery, quality changes) keep the last requested quality so a
    // recovery doesn't silently revert an adapted stream back to "best".
    var requested_quality = quality || stream_quality_choice[name] || "best";
    stream_load_pending[name] = true;
    set_player_status(tile, "Loading stream...");
    $.ajax({
        url: "/api/direct-stream/" + encodeURIComponent(name),
        data: {quality: requested_quality, refresh: force_refresh ? "1" : "0"},
        timeout: 20000,
        success: function(data) {
            attach_hls_stream(tile, name, video, data.url);
            stream_load_pending[name] = false;
            maybe_release_startup_sync();
            if (stream_players[name]) {
                // What the server actually served (may differ from requested),
                // plus the menu of available renditions, for the adapter.
                stream_players[name].quality = data.quality || requested_quality;
                stream_players[name].qualities = data.qualities || [];
            }
        },
        error: function(xhr, text_status, error_thrown) {
            stream_load_pending[name] = false;
            maybe_release_startup_sync();
            log_stream_api_error(name, xhr, text_status, error_thrown);
            var message = (xhr.responseJSON && xhr.responseJSON.error) || "Could not load stream.";
            if (stream_players[name]) {
                stream_players[name].recovering = false;
                stream_players[name].stalled = true;
                update_stream_playback_state(name);
                schedule_stream_recovery(name);
            }
            classify_stream_load_error(tile, name, message);
        }
    });
}

function stream_api_error_diagnostics(name, xhr, text_status, error_thrown) {
    xhr = xhr || {};
    return {
        channel: name,
        status: xhr.status || 0,
        status_text: xhr.statusText || text_status || null,
        error: error_thrown ? String(error_thrown) : null,
        response: xhr.responseJSON && xhr.responseJSON.error
            ? String(xhr.responseJSON.error).slice(0, 200)
            : (xhr.responseText ? String(xhr.responseText).slice(0, 200) : null)
    };
}

function log_stream_api_error(name, xhr, text_status, error_thrown) {
    console.error("[MultiTwitch] Stream API error " + JSON.stringify(
        stream_api_error_diagnostics(name, xhr, text_status, error_thrown)
    ));
}

function classify_stream_load_error(tile, name, fallback_message) {
    if (fallback_message == "Stream offline.") {
        set_player_status(tile, fallback_message);
        return;
    }
    $.ajax({
        url: "/api/twitch/live-status/" + encodeURIComponent(name),
        timeout: 10000,
        success: function(data) {
            if (data.live === false) {
                var player = stream_players[name];
                if (player) {
                    player.recovering = false;
                    player.stalled = true;
                    if (player.recovery_timer) {
                        clearTimeout(player.recovery_timer);
                        player.recovery_timer = null;
                    }
                }
                set_player_status(tile, "Stream offline.");
                return;
            }
            set_player_status(tile, fallback_message);
        },
        error: function() {
            set_player_status(tile, fallback_message);
        }
    });
}

// hls.js fetches the playlist via a cross-origin JS request, which Twitch's
// playlist host 403s from non-Twitch origins. Route just the playlist through
// our same-origin proxy; segments stay absolute and load direct from the CDN.
function hls_proxy_url(url) {
    return "/api/hls-proxy?url=" + encodeURIComponent(url);
}

function attach_hls_stream(tile, name, video, url) {
    var recovery_attempt = stream_players[name] ? stream_players[name].recovery_attempt : 0;
    destroy_stream_player(name);
    // Set both the live mute flag and its reflected default before attaching a
    // source. Leaving the element's original `muted` attribute behind allowed
    // Edge to reset an optimistic audible restore back to muted during attach.
    var initial_audio = stream_audio_target(name);
    set_video_muted(video, initial_audio.muted);
    video.volume = initial_audio.muted ? 0.0 : initial_audio.volume;
    stream_players[name] = {
        name: name,
        video: video,
        hls: null,
        manual_paused: false,
        stalled: false,
        recovering: false,
        last_time: video.currentTime || 0,
        last_progress_at: Date.now(),
        recovery_attempt: recovery_attempt,
        hls_recover_attempt: 0,
        engine: null,
        native_fallback_timer: null,
        recovery_timer: null,
        resume_timer: null,
        muted_resume_timer: null,
        resume_blocked: false,
        startup_pending: true,
        startup_started_at: Date.now(),
        startup_progress_started_at: 0,
        startup_sync_ready: false,
        startup_sync_released: false,
        startup_sync_details: null,
        startup_sync_start_position: null,
        is_straggler: false,
        straggler_enter_ticks: 0,
        straggler_exit_ticks: 0,
        last_audible_play_blocked_at: 0,
        last_convergence_seek_at: 0
    };
    $(video).off(".playbackRecovery")
        .on("pause.playbackRecovery", function() {
            var player = stream_players[name];
            if (!player || player.video !== video) {
                return;
            }
            update_stream_playback_state(name);
            // Only treat a pause as "audio was blocked" once the stream is past
            // startup. During startup a pause is just buffering (hls.js attach,
            // first segments) -- muting + re-locking here would silence a stream
            // the browser would have played with sound. safe_play() is the sole
            // authority on a genuine NotAllowedError refusal.
            if (!player.manual_paused && !player.startup_pending &&
                resume_muted_after_blocked_audio(player)) {
                return;
            }
            // Ignore pauses caused by the tab/window going to the background --
            // browsers pause muted video there. We resume gently on return
            // rather than fighting it (which caused reload churn).
            if (!player.manual_paused && page_active()) {
                setTimeout(function() {
                    ensure_stream_playing(name);
                }, 250);
            }
        })
        .on("playing.playbackRecovery", function() {
            var player = stream_players[name];
            if (player && player.video === video) {
                if (!video.muted) {
                    audio_restore_pending = false;
                }
                player.recovering = false;
                player.recovery_attempt = 0;
                player.hls_recover_attempt = 0;
                player.resume_blocked = false;
                player.last_progress_at = Date.now();
                player.last_time = video.currentTime || 0;
                if (!player.resume_timer && !player.startup_pending) {
                    player.stalled = false;
                    set_player_status(tile, "");
                }
            }
            update_stream_playback_state(name);
        })
        .on("timeupdate.playbackRecovery", function() {
            var player = stream_players[name];
            if (player && player.video === video && video.currentTime > player.last_time + 0.05) {
                var now = Date.now();
                player.last_time = video.currentTime;
                player.last_progress_at = now;
                player.recovery_attempt = 0;
                player.resume_blocked = false;
                player.stalled = false;
                if (startup_progress_is_stable(player, now)) {
                    complete_stream_startup(name, player, tile);
                }
                if (player.resume_timer) {
                    clearTimeout(player.resume_timer);
                    player.resume_timer = null;
                }
                if (!player.startup_pending) {
                    set_player_status(tile, "");
                }
                update_stream_playback_state(name);
            }
        })
        .on("ended.playbackRecovery", function() {
            handle_stream_playback_failure(name);
        })
        .on("error.playbackRecovery", function() {
            log_native_media_error(name, video);
            handle_stream_playback_failure(name);
        });
    var engine = desired_player_engine(name, video);
    stream_players[name].engine = engine;
    if (engine === "hls") {
        // Start CONVERGENCE_STARTUP_LATENCY behind the (prefetch-promoted)
        // edge -- deep enough that every wanted segment is complete, for a
        // smooth start; the convergence tick then glides the stream onto the
        // shared wall. We use liveSyncDuration
        // in seconds rather than a segment count because Twitch can report a
        // large target duration; with lowLatencyMode on, hls.js derived its
        // hold-back from 3x that and started ~18s back. An absolute value pins
        // the start near live regardless. lowLatencyMode is off (it gave no
        // benefit for Twitch's non-standard prefetch and drove the latency
        // controller to seek/fight the app's own steering); we also avoid
        // maxLiveSyncPlaybackRate / liveMaxLatencyDurationCount for the same
        // reason. The earlier "needs a click to start" was an autoplay-blocker
        // browser extension, not this config.
        var hls = new Hls({
            liveSyncDuration: CONVERGENCE_STARTUP_LATENCY,
            nudgeMaxRetry: 5,
            // Bound the MSE SourceBuffer hard, per tile, so a multi-hour session
            // across several streams can't climb until the tab dies with "Out of
            // Memory" (a silent browser-level abort, no console error).
            //
            //   backBufferLength   played-out media kept behind the playhead.
            //                      Default is Infinity -> grows forever. We never
            //                      scrub backwards, so a few seconds is plenty.
            //   maxMaxBufferLength the real forward cap. Default 600s lets hls.js
            //                      balloon each tile to ~10 min of video when
            //                      bandwidth allows -- the headroom that survived
            //                      the earlier backBufferLength-only fix.
            //   maxBufferSize      hard byte cap on the forward buffer; the binding
            //                      limit for Twitch's high-bitrate renditions.
            backBufferLength: 10,
            maxBufferLength: 20,
            maxMaxBufferLength: 40,
            maxBufferSize: 30 * 1000 * 1000
        });
        stream_players[name].hls = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, function() {
            retry_hls_startup_play(name, hls, video);
        });
        hls.on(Hls.Events.LEVEL_LOADED, function(event, data) {
            coordinate_startup_toward_wall(name, hls, data && data.details);
        });
        hls.on(Hls.Events.FRAG_BUFFERED, function() {
            maybe_release_startup_sync();
            retry_hls_startup_play(name, hls, video);
        });
        hls.on(Hls.Events.ERROR, function(event, data) {
            if (data && data.fatal) {
                var player = stream_players[name];
                if (!player || player.hls !== hls) {
                    return;
                }
                log_fatal_hls_error(name, data);
                if (recover_fatal_hls_error(name, hls, data)) {
                    return;
                }
                handle_stream_playback_failure(name);
            }
        });
        hls.loadSource(hls_proxy_url(url));
        hls.attachMedia(video);
    } else if (engine === "native") {
        // Native playback loads the Twitch playlist directly -- no hls.js, no
        // proxy hop -- so it starts fast and close to live. If the browser
        // reports HLS support but can't actually play the stream, a watchdog
        // pins the channel to hls.js and reloads.
        video.src = url;
        schedule_native_startup_fallback(name);
    } else {
        set_player_status(tile, "This browser cannot play HLS streams.");
        return;
    }
    play_stream_with_target_audio(name, video);
}

// hls.js is preferred wherever it runs: it reliably plays Twitch's MPEG-TS and
// it's required for convergence (native HLS exposes no latency/seek control).
// Chromium 142+ (Chrome/Edge, Dec 2025) added a native HLS demuxer, which flips
// canPlayType() truthy on desktop -- but that demuxer can't parse Twitch's
// low-latency MPEG-TS prefetch streams (DEMUXER_ERROR_COULD_NOT_PARSE), so an
// engine policy that preferred native silently routed Twitch into a broken path.
// We fall back to native HLS only where hls.js isn't available -- notably iOS
// Safari, where MSE is absent (Hls.isSupported() === false) and native HLS works.
function desired_player_engine(name, video) {
    var native_supported = !!(video && video.canPlayType("application/vnd.apple.mpegurl"));
    var hls_js_supported = !!(window.Hls && Hls.isSupported());
    if (hls_js_supported) {
        return "hls";
    }
    if (native_supported) {
        return "native";
    }
    return null;
}

// Native reported support but may not actually play Twitch's MPEG-TS segments.
// If it hasn't started within a few seconds, fall back to hls.js.
function schedule_native_startup_fallback(name) {
    var player = stream_players[name];
    if (!player) {
        return;
    }
    if (player.native_fallback_timer) {
        clearTimeout(player.native_fallback_timer);
    }
    player.native_fallback_timer = setTimeout(function() {
        var current = stream_players[name];
        if (!current || current.engine !== "native" || !current.startup_pending ||
            current.manual_paused) {
            return;
        }
        // If playback has actually advanced, native is working (just settling) --
        // don't yank it. Only fall back when nothing has played at all.
        if ((current.video && current.video.currentTime || 0) > 0.2) {
            return;
        }
        if (window.Hls && Hls.isSupported()) {
            stream_force_hls_js[name] = true;
            reload_stream_playback(name);
        }
    }, 4000);
}

function clear_native_fallback_timer(player) {
    if (player && player.native_fallback_timer) {
        clearTimeout(player.native_fallback_timer);
        player.native_fallback_timer = null;
    }
}

function startup_progress_is_stable(player, now) {
    if (!player || !player.startup_pending) {
        return false;
    }
    if (!player.startup_progress_started_at) {
        player.startup_progress_started_at = now;
        return false;
    }
    return now - player.startup_progress_started_at >= 750;
}

function complete_stream_startup(name, player, tile) {
    if (!player || !player.startup_pending) {
        return;
    }
    player.startup_pending = false;
    player.stalled = false;
    clear_native_fallback_timer(player);
    set_player_status(tile, "");
    sync_active_stream_audio();
}

function retry_hls_startup_play(name, hls, video) {
    var player = stream_players[name];
    if (!player || !player.startup_pending || player.hls !== hls ||
        player.video !== video || player.manual_paused || !video.paused ||
        player.startup_sync_released === false) {
        return;
    }
    player.resume_blocked = false;
    player.last_progress_at = Date.now();
    play_stream_with_target_audio(name, video);
}

function sanitize_playback_url(value) {
    if (!value) {
        return null;
    }
    var text = String(value);
    try {
        var parsed = new URL(text, window.location && window.location.href);
        var extension_match = parsed.pathname.match(/(\.[A-Za-z0-9]+)$/);
        return parsed.origin + "/[redacted]" + (extension_match ? extension_match[1] : "");
    } catch (e) {
        return "[redacted]";
    }
}

function hls_error_diagnostics(name, data) {
    data = data || {};
    var response = data.response || {};
    var context = data.context || {};
    var frag = data.frag || {};
    return {
        channel: name,
        type: data.type || null,
        details: data.details || null,
        reason: sanitize_hls_text(data.reason, 1000),
        response_code: response.code || response.status || null,
        response_text: sanitize_hls_text(response.text, 200),
        url: sanitize_playback_url(data.url || response.url || context.url || frag.url)
    };
}

function sanitize_hls_text(value, limit) {
    if (!value) {
        return null;
    }
    return String(value).replace(/https?:\/\/[^\s"']+/g, function(url) {
        return sanitize_playback_url(url);
    }).slice(0, limit);
}

function log_fatal_hls_error(name, data) {
    console.error("[MultiTwitch] Fatal hls.js error " + JSON.stringify(hls_error_diagnostics(name, data)));
}

function log_native_media_error(name, video) {
    var media_error = video && video.error;
    console.error("[MultiTwitch] Native media error " + JSON.stringify({
        channel: name,
        code: media_error ? media_error.code : null,
        message: media_error && media_error.message ? media_error.message : null,
        network_state: video ? video.networkState : null,
        ready_state: video ? video.readyState : null,
        url: sanitize_playback_url(video && (video.currentSrc || video.src))
    }));
}

// hls.js can usually recover a fatal error in place -- resume the network loader
// (NETWORK_ERROR) or flush and rebuild the media buffer (MEDIA_ERROR) -- far
// faster than re-resolving the stream from scratch. This matters most at startup,
// where a single slow or empty fragment at the thin live edge used to spiral into
// a loading <-> reconnecting loop until the user hit play. We try a few light
// recoveries (then fall back to a full reload) and snap toward the live edge so
// playback actually resumes on its own -- the same thing the play button does.
function recover_fatal_hls_error(name, hls, data) {
    var player = stream_players[name];
    if (!player || player.hls !== hls || !window.Hls) {
        return false;
    }
    player.hls_recover_attempt = (player.hls_recover_attempt || 0) + 1;
    if (player.hls_recover_attempt > 3) {
        return false;
    }
    try {
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad(-1);
        } else {
            return false;
        }
    } catch (e) {
        return false;
    }
    set_player_status(stream_tile_by_name(name), "Reconnecting stream...");
    try {
        var video = player.video;
        if (video && video.seekable && video.seekable.length) {
            var live_edge = video.seekable.end(video.seekable.length - 1);
            if (live_edge - (video.currentTime || 0) > 0.5) {
                video.currentTime = Math.max(0, live_edge - 0.5);
            }
        }
    } catch (e2) {}
    safe_play(player.video);
    return true;
}

function handle_stream_playback_failure(name) {
    var player = stream_players[name];
    if (!player) {
        return;
    }
    clear_native_fallback_timer(player);
    // Native HLS couldn't keep this stream playing -> pin it to hls.js.
    if (player.engine === "native" && window.Hls && Hls.isSupported()) {
        stream_force_hls_js[name] = true;
    }
    mark_stream_stalled(name, "Reconnecting stream...");
    schedule_stream_recovery(name);
}

function initialize_playback_recovery() {
    $(document).on("visibilitychange.playbackRecovery", function() {
        if (!document.hidden) {
            resume_all_after_inactive();
        }
    });
    $(window).on("focus.playbackRecovery pageshow.playbackRecovery", resume_all_after_inactive);
    setInterval(ensure_all_streams_playing, 5000);
    setInterval(update_stream_latency_labels, 1000);
}

// Latency for display fallback: prefer the capped-PDT measurement over
// hls.latency. hls.latency measures against the raw in-flight edge, which on
// long-segment channels (4s+) swings by up to two segment durations as
// playlists re-base.
function display_stream_latency(player) {
    var edge = player_edge_pdt(player);
    var playing = player_playing_pdt(player);
    if (edge !== null && playing !== null) {
        return (edge - playing) / 1000;
    }
    return measure_player_latency(player);
}

function display_stream_sync_offset(player) {
    var target = convergence_target_pdt();
    var playing = player_playing_pdt(player);
    if (target !== null && playing !== null) {
        return (target - playing) / 1000;
    }
    return null;
}

function format_stream_sync_offset(offset) {
    if (Math.abs(offset) < 0.05) {
        offset = 0;
    }
    return (offset > 0 ? "+" : "") + offset.toFixed(1) + "s";
}

// Refresh each tile's sync readout (revealed on hover). Prefer the offset from
// the shared wall over raw live latency: two streams can be visually aligned
// while intentionally sitting at different distances from their own live edges.
// Light smoothing keeps measurement noise from flickering.
function update_stream_latency_labels() {
    for (var name in stream_players) {
        if (!Object.prototype.hasOwnProperty.call(stream_players, name)) {
            continue;
        }
        var player = stream_players[name];
        var label = stream_tile_by_name(name).find(".stream_latency");
        if (!label.length) {
            continue;
        }
        // Native HLS exposes no reliable live-latency signal (only hls.js does),
        // so suppress the readout entirely rather than show a misleading number
        // derived from the seekable range. Empty text hides it via :empty.
        if (player && player.engine === "native") {
            player.display_latency = null;
            label.text("").removeAttr("title");
            continue;
        }
        var offset = player && !player.manual_paused ? display_stream_sync_offset(player) : null;
        var value = offset !== null ? offset : (player && !player.manual_paused ? display_stream_latency(player) : null);
        if (value === null || !isFinite(value)) {
            player.display_latency = null;
            label.text("").removeAttr("title");
            continue;
        }
        player.display_latency = player.display_latency == null
            ? value
            : player.display_latency * 0.5 + value * 0.5;
        if (offset !== null) {
            label.text(format_stream_sync_offset(player.display_latency)).attr("title", "Offset from sync target");
        } else {
            label.text(player.display_latency.toFixed(1) + "s").attr("title", "Delay behind live");
        }
    }
}

function measure_player_latency(player) {
    if (!player || !player.video) {
        return null;
    }
    if (player.hls && typeof player.hls.latency === "number" && isFinite(player.hls.latency) && player.hls.latency > 0) {
        return player.hls.latency;
    }
    if (player.hls && player.hls.latestLevelDetails) {
        var details = player.hls.latestLevelDetails;
        if (details.live && typeof details.edge === "number") {
            return Math.max(0, details.edge + (details.age || 0) - (player.video.currentTime || 0));
        }
    }
    try {
        var seekable = player.video.seekable;
        if (seekable && seekable.length) {
            return Math.max(0, seekable.end(seekable.length - 1) - (player.video.currentTime || 0));
        }
    } catch (e) {}
    return null;
}

function player_seek_bounds(player) {
    try {
        var seekable = player.video.seekable;
        if (seekable && seekable.length) {
            var index = seekable.length - 1;
            return {start: seekable.start(index), end: seekable.end(index)};
        }
    } catch (e) {}
    if (player.hls && player.hls.latestLevelDetails) {
        var details = player.hls.latestLevelDetails;
        if (details.live && typeof details.edge === "number" && typeof details.totalduration === "number") {
            return {
                start: Math.max(0, details.edge - details.totalduration),
                end: details.edge
            };
        }
    }
    return null;
}

// --- Convergence controller ------------------------------------------------
// Always-on near-live alignment (docs/obsolete-stream-sync.md).

// Debug bypass while the controller soaks: ?nosync=1 in the URL, or
// localStorage "multitwitch.nosync" = "1". Checked once at startup.
function convergence_kill_switch_active() {
    try {
        if (/[?&]nosync=1(&|$)/.test(window.location.search)) {
            return true;
        }
    } catch (e) {}
    try {
        if (window.localStorage.getItem("multitwitch.nosync") === "1") {
            return true;
        }
    } catch (e) {}
    return false;
}

function initialize_convergence() {
    convergence_disabled = convergence_kill_switch_active();
    sync_debug_enabled = sync_debug_active();
    if (!convergence_disabled && !convergence_timer) {
        convergence_timer = setInterval(run_convergence, CONVERGENCE_INTERVAL);
    }
}

function sync_debug_active() {
    try {
        if (/[?&]syncdebug=1(&|$)/.test(window.location.search)) {
            return true;
        }
    } catch (e) {}
    try {
        if (window.localStorage.getItem("multitwitch.syncdebug") === "1") {
            return true;
        }
    } catch (e) {}
    return false;
}

function sync_debug_log(label, fields) {
    if (!sync_debug_enabled || !window.console || !console.log) {
        return;
    }
    try {
        console.log("[StreamMulti sync] " + label, fields);
    } catch (e) {}
}

// Wall-clock time (ms) of the playhead, from the playlist's
// EXT-X-PROGRAM-DATE-TIME. hls.js interpolates within the fragment, so unlike
// the latency measurement this advances continuously -- no per-segment
// sawtooth, no smoothing needed.
function player_playing_pdt(player) {
    if (!player || !player.hls) {
        return null;
    }
    var date = null;
    try {
        date = player.hls.playingDate;
    } catch (e) {
        return null;
    }
    if (!date || typeof date.getTime !== "function") {
        return null;
    }
    var ms = date.getTime();
    return isFinite(ms) ? ms : null;
}

// Wall-clock time (ms) the channel's ingest has delivered up to. The playlist
// only advances in ~2s segment steps, so the last fragment's PDT is a
// staircase; adding the playlist's age (time since it was fetched) restores a
// continuous estimate -- the two terms form complementary sawtooths. Promoted
// prefetch segments carry no PDT tag; hls.js extrapolates theirs from the last
// tagged fragment plus durations.
function details_edge_pdt(details) {
    if (!details || !details.live || !details.fragments || !details.fragments.length) {
        return null;
    }
    var frag = details.fragments[details.fragments.length - 1];
    if (!frag || typeof frag.programDateTime !== "number" || !isFinite(frag.programDateTime)) {
        return null;
    }
    var edge = frag.programDateTime + (frag.duration || 0) * 1000 + (details.age || 0) * 1000;
    // Promoted prefetch segments advertise in-flight content, so the raw edge
    // can sit up to ~2 segment durations past realtime (measured +4s on a
    // channel with 4.17s segments) -- and by a different amount per channel,
    // which would inflate cross-channel offsets and push other streams several
    // seconds further behind than needed. Content cannot exist in the future:
    // cap at the client clock.
    return Math.min(edge, Date.now());
}

function player_edge_pdt(player) {
    if (!player || !player.hls) {
        return null;
    }
    try {
        return details_edge_pdt(player.hls.latestLevelDetails);
    } catch (e) {
        return null;
    }
}

function details_segment_duration(details) {
    if (!details || !details.fragments || !details.fragments.length) {
        return null;
    }
    var durations = [];
    var start = Math.max(0, details.fragments.length - 8);
    for (var i = start; i < details.fragments.length; i++) {
        var duration = details.fragments[i] && details.fragments[i].duration;
        if (typeof duration === "number" && isFinite(duration) && duration > 0.25 && duration < 30) {
            durations.push(duration);
        }
    }
    if (!durations.length) {
        return null;
    }
    durations.sort(function(a, b) { return a - b; });
    return durations[Math.floor(durations.length / 2)];
}

function details_holdback_seconds(details) {
    var segment_duration = details_segment_duration(details);
    if (segment_duration === null) {
        return CONVERGENCE_HOLDBACK;
    }
    return Math.min(CONVERGENCE_MAX_HOLDBACK,
        Math.max(CONVERGENCE_HOLDBACK, segment_duration * CONVERGENCE_HOLDBACK_SEGMENTS));
}

function player_holdback_seconds(player) {
    try {
        return details_holdback_seconds(player && player.hls && player.hls.latestLevelDetails);
    } catch (e) {
        return CONVERGENCE_HOLDBACK;
    }
}

function details_min_buffer_seconds(details) {
    var segment_duration = details_segment_duration(details);
    if (segment_duration === null) {
        return CONVERGENCE_MIN_BUFFER;
    }
    return Math.max(CONVERGENCE_MIN_BUFFER, segment_duration * CONVERGENCE_MIN_BUFFER_SEGMENTS);
}

function player_min_buffer_seconds(player) {
    try {
        return details_min_buffer_seconds(player && player.hls && player.hls.latestLevelDetails);
    } catch (e) {
        return CONVERGENCE_MIN_BUFFER;
    }
}

function details_startup_latency_seconds(details) {
    var segment_duration = details_segment_duration(details);
    if (segment_duration === null) {
        return CONVERGENCE_STARTUP_LATENCY;
    }
    return Math.min(CONVERGENCE_MAX_STARTUP_LATENCY,
        Math.max(CONVERGENCE_STARTUP_LATENCY, segment_duration * CONVERGENCE_STARTUP_SEGMENTS));
}

function details_straggler_enter_seconds(details) {
    var segment_duration = details_segment_duration(details);
    if (segment_duration === null) {
        return CONVERGENCE_STRAGGLER_LIMIT;
    }
    return Math.max(CONVERGENCE_STRAGGLER_LIMIT, segment_duration * CONVERGENCE_STRAGGLER_SEGMENTS);
}

function details_straggler_exit_seconds(details) {
    return Math.max(0, details_straggler_enter_seconds(details) - CONVERGENCE_STRAGGLER_EXIT_MARGIN);
}

function player_straggler_enter_seconds(player) {
    try {
        return details_straggler_enter_seconds(player && player.hls && player.hls.latestLevelDetails);
    } catch (e) {
        return CONVERGENCE_STRAGGLER_LIMIT;
    }
}

function player_straggler_exit_seconds(player) {
    try {
        return details_straggler_exit_seconds(player && player.hls && player.hls.latestLevelDetails);
    } catch (e) {
        return Math.max(0, CONVERGENCE_STRAGGLER_LIMIT - CONVERGENCE_STRAGGLER_EXIT_MARGIN);
    }
}

function update_stream_straggler_badge(name, active) {
    try {
        var tile = stream_tile_by_name(name);
        if (!tile || !tile.length) {
            return;
        }
        var badge = tile.find(".stream_straggler");
        if (active) {
            if (!badge.length) {
                badge = $("<div>", {"class": "stream_straggler", "aria-hidden": "true"}).appendTo(tile);
            }
            badge.text("Catching up").attr("title", "This stream is behind the group and catching up independently.");
        } else {
            badge.remove();
        }
    } catch (e) {}
}

// The shared wall: the newest wall-clock instant every healthy channel has
// delivered, minus the holdback. `edges` is an array of edge PDTs in ms. An
// edge trailing the freshest by more than the straggler limit is a stalled
// playlist and is excluded -- it keeps steering toward the wall on its own and
// rejoins the derivation once its edge recovers.
function compute_convergence_target(edges, holdback_seconds, straggler_limit_seconds) {
    if (holdback_seconds === undefined) {
        holdback_seconds = CONVERGENCE_HOLDBACK;
    }
    if (straggler_limit_seconds === undefined) {
        straggler_limit_seconds = CONVERGENCE_STRAGGLER_LIMIT;
    }
    var freshest = null;
    var i, edge;
    for (i = 0; i < edges.length; i++) {
        edge = edges[i];
        if (typeof edge === "number" && isFinite(edge) && (freshest === null || edge > freshest)) {
            freshest = edge;
        }
    }
    if (freshest === null) {
        return null;
    }
    var slowest = null;
    for (i = 0; i < edges.length; i++) {
        edge = edges[i];
        if (typeof edge !== "number" || !isFinite(edge) ||
            freshest - edge > straggler_limit_seconds * 1000) {
            continue;
        }
        if (slowest === null || edge < slowest) {
            slowest = edge;
        }
    }
    return slowest - holdback_seconds * 1000;
}

function compute_convergence_target_for_players(players, straggler_limit_seconds) {
    var freshest = null;
    var i, entry;
    for (i = 0; i < players.length; i++) {
        entry = players[i];
        if (entry.edge_pdt !== null && typeof entry.edge_pdt === "number" && isFinite(entry.edge_pdt) &&
            entry.playing_pdt !== null && (freshest === null || entry.edge_pdt > freshest)) {
            freshest = entry.edge_pdt;
        }
    }
    if (freshest === null) {
        return null;
    }
    var target = null;
    for (i = 0; i < players.length; i++) {
        entry = players[i];
        var limit = straggler_limit_seconds === undefined
            ? (entry.straggler_enter_seconds || CONVERGENCE_STRAGGLER_LIMIT)
            : straggler_limit_seconds;
        if (entry.edge_pdt === null || typeof entry.edge_pdt !== "number" || !isFinite(entry.edge_pdt) ||
            entry.playing_pdt === null || entry.is_straggler || freshest - entry.edge_pdt > limit * 1000) {
            continue;
        }
        var candidate = entry.edge_pdt - entry.holdback_seconds * 1000;
        if (target === null || candidate < target) {
            target = candidate;
        }
    }
    return target;
}

// behind > 0 -> the playhead is showing an older instant than the target.
// Within the dead-band: converged, leave it alone. Up to the seek threshold:
// proportional rate nudge with asymmetric caps (speeding toward live is far
// less noticeable than slowing). Past the threshold: a visible seek, clamped
// inside the seekable range. buffered_ahead (optional, seconds of media
// buffered past the playhead) gates speed-ups: with a thin buffer a rate
// increase can only starve playback, so hold 1x and let the buffer refill.
function convergence_correction(behind, current_time, seek_start, seek_end, buffered_ahead, min_buffer) {
    if (min_buffer === undefined) {
        min_buffer = CONVERGENCE_MIN_BUFFER;
    }
    var magnitude = Math.abs(behind);
    if (magnitude >= CONVERGENCE_SEEK_THRESHOLD) {
        var seek_to = Math.max(seek_start + 0.1, Math.min(seek_end - 0.25, current_time + behind));
        return {seek_to: seek_to, playback_rate: 1};
    }
    if (magnitude < CONVERGENCE_DEADBAND) {
        return {seek_to: null, playback_rate: 1};
    }
    if (behind > 0 && buffered_ahead !== null && buffered_ahead !== undefined &&
        buffered_ahead < min_buffer) {
        return {seek_to: null, playback_rate: 1};
    }
    var fraction = (magnitude - CONVERGENCE_DEADBAND) /
        (CONVERGENCE_SEEK_THRESHOLD - CONVERGENCE_DEADBAND);
    var cap = behind > 0 ? CONVERGENCE_MAX_SPEEDUP : CONVERGENCE_MAX_SLOWDOWN;
    var adjust = CONVERGENCE_MIN_NUDGE + (cap - CONVERGENCE_MIN_NUDGE) * fraction;
    return {seek_to: null, playback_rate: behind > 0 ? 1 + adjust : 1 - adjust};
}

// Seconds of media buffered ahead of the playhead, or null when unknowable.
function player_buffered_ahead(video) {
    try {
        var buffered = video.buffered;
        var current = video.currentTime || 0;
        for (var i = 0; i < buffered.length; i++) {
            if (buffered.start(i) <= current + 0.1 && current <= buffered.end(i)) {
                return Math.max(0, buffered.end(i) - current);
            }
        }
    } catch (e) {}
    return null;
}

// A player participates only while genuinely playing: startup, recovery and
// manual pauses are excluded (their positions are in flux, and steering them
// would fight the recovery machinery). Native-engine players (iOS Safari)
// expose no latency/seek control and are left alone entirely.
function collect_convergence_players() {
    var collected = [];
    for (var name in stream_players) {
        if (!Object.prototype.hasOwnProperty.call(stream_players, name)) {
            continue;
        }
        var player = stream_players[name];
        if (!player || !player.video || player.engine !== "hls" ||
            player.manual_paused || player.recovering || player.startup_pending) {
            continue;
        }
        var edge_pdt = player_edge_pdt(player);
        var playing_pdt = player_playing_pdt(player);
        // A channel with a wildly wrong clock would poison the shared wall;
        // treat it as PDT-less so it self-holds via the latency fallback.
        if (edge_pdt !== null && Math.abs(edge_pdt - Date.now()) > CONVERGENCE_PDT_SANITY_LIMIT * 1000) {
            edge_pdt = null;
            playing_pdt = null;
        }
        collected.push({
            name: name,
            player: player,
            edge_pdt: edge_pdt,
            playing_pdt: playing_pdt,
            holdback_seconds: player_holdback_seconds(player),
            min_buffer_seconds: player_min_buffer_seconds(player),
            straggler_enter_seconds: player_straggler_enter_seconds(player),
            straggler_exit_seconds: player_straggler_exit_seconds(player),
            is_straggler: !!player.is_straggler
        });
    }
    return collected;
}

function update_convergence_straggler_states(players) {
    var freshest = null;
    var i, entry;
    for (i = 0; i < players.length; i++) {
        entry = players[i];
        if (entry.edge_pdt !== null && typeof entry.edge_pdt === "number" && isFinite(entry.edge_pdt) &&
            (freshest === null || entry.edge_pdt > freshest)) {
            freshest = entry.edge_pdt;
        }
    }
    if (freshest === null) {
        return;
    }
    for (i = 0; i < players.length; i++) {
        entry = players[i];
        var player = entry.player;
        if (!player) {
            continue;
        }
        if (entry.edge_pdt === null || typeof entry.edge_pdt !== "number" || !isFinite(entry.edge_pdt)) {
            player.straggler_enter_ticks = 0;
            player.straggler_exit_ticks = 0;
            continue;
        }
        var gap = (freshest - entry.edge_pdt) / 1000;
        if (player.is_straggler) {
            if (gap < entry.straggler_exit_seconds) {
                player.straggler_exit_ticks = (player.straggler_exit_ticks || 0) + 1;
            } else {
                player.straggler_exit_ticks = 0;
            }
            if (player.straggler_exit_ticks >= CONVERGENCE_STRAGGLER_EXIT_TICKS) {
                player.is_straggler = false;
                player.straggler_enter_ticks = 0;
                player.straggler_exit_ticks = 0;
            }
        } else {
            if (gap > entry.straggler_enter_seconds) {
                player.straggler_enter_ticks = (player.straggler_enter_ticks || 0) + 1;
            } else {
                player.straggler_enter_ticks = 0;
            }
            if (player.straggler_enter_ticks >= CONVERGENCE_STRAGGLER_ENTER_TICKS) {
                player.is_straggler = true;
                player.straggler_enter_ticks = 0;
                player.straggler_exit_ticks = 0;
            }
        }
        entry.is_straggler = !!player.is_straggler;
        update_stream_straggler_badge(entry.name, entry.is_straggler);
        sync_debug_log("straggler", {
            name: entry.name,
            gap: Number(gap.toFixed(3)),
            enter: entry.straggler_enter_seconds,
            exit: entry.straggler_exit_seconds,
            active: entry.is_straggler
        });
    }
}

// The shared wall as currently computable from the healthy players -- the same
// derivation run_convergence uses each tick, exposed for one-shot callers
// (snap-to-live, startup bias). Null when no player has usable PDT.
function convergence_target_pdt() {
    var players = collect_convergence_players();
    return compute_convergence_target_for_players(players);
}

function startup_sync_candidate_names() {
    var names = {};
    for (var i = 0; i < streams.length; i++) {
        names[streams[i]] = true;
    }
    for (var name in stream_players) {
        if (Object.prototype.hasOwnProperty.call(stream_players, name)) {
            names[name] = true;
        }
    }
    return names;
}

function startup_sync_waiting_for_loads() {
    var names = startup_sync_candidate_names();
    for (var name in names) {
        if (Object.prototype.hasOwnProperty.call(names, name) && stream_load_pending[name]) {
            return true;
        }
    }
    return false;
}

function startup_sync_ready_players() {
    var ready = [];
    for (var name in stream_players) {
        if (!Object.prototype.hasOwnProperty.call(stream_players, name)) {
            continue;
        }
        var player = stream_players[name];
        if (player && player.engine === "hls" && player.startup_pending &&
            player.startup_sync_ready && !player.startup_sync_released &&
            player.startup_sync_details) {
            ready.push({name: name, player: player, details: player.startup_sync_details});
        }
    }
    return ready;
}

function startup_sync_has_unready_players() {
    for (var name in stream_players) {
        if (!Object.prototype.hasOwnProperty.call(stream_players, name)) {
            continue;
        }
        var player = stream_players[name];
        if (player && player.engine === "hls" && player.startup_pending &&
            !player.startup_sync_released && !player.startup_sync_ready) {
            return true;
        }
    }
    return false;
}

function startup_sync_target_pdt(entries, use_startup_fallback) {
    var freshest = null;
    var edge, i;
    for (i = 0; i < entries.length; i++) {
        edge = details_edge_pdt(entries[i].details);
        if (edge === null || Math.abs(edge - Date.now()) > CONVERGENCE_PDT_SANITY_LIMIT * 1000) {
            continue;
        }
        if (freshest === null || edge > freshest) {
            freshest = edge;
        }
    }
    if (freshest === null) {
        return null;
    }
    var target = null;
    for (i = 0; i < entries.length; i++) {
        edge = details_edge_pdt(entries[i].details);
        if (edge === null || Math.abs(edge - Date.now()) > CONVERGENCE_PDT_SANITY_LIMIT * 1000) {
            continue;
        }
        if (freshest - edge > details_straggler_enter_seconds(entries[i].details) * 1000) {
            continue;
        }
        var holdback = use_startup_fallback
            ? details_startup_latency_seconds(entries[i].details)
            : details_holdback_seconds(entries[i].details);
        var candidate = edge - holdback * 1000;
        if (target === null || candidate < target) {
            target = candidate;
        }
    }
    return target;
}

function release_startup_player(player) {
    if (!player || player.startup_sync_released) {
        return;
    }
    player.startup_sync_released = true;
    apply_startup_start_position(player);
    if (player.hls && player.video) {
        retry_hls_startup_play(player.name, player.hls, player.video);
    }
}

function startup_start_position(details, live_sync_duration) {
    if (!details || typeof details.edge !== "number" || !isFinite(details.edge) ||
        typeof live_sync_duration !== "number" || !isFinite(live_sync_duration)) {
        return null;
    }
    var age = typeof details.age === "number" && isFinite(details.age) ? Math.max(0, details.age) : 0;
    var start = details.edge + age - live_sync_duration;
    var lower = 0;
    if (typeof details.totalduration === "number" && isFinite(details.totalduration) && details.totalduration > 0) {
        lower = Math.max(0, details.edge - details.totalduration);
    }
    var upper = Math.max(lower, details.edge);
    return Math.max(lower, Math.min(upper, start));
}

function remember_startup_start_position(player, details) {
    if (!player || !player.hls || !player.hls.config) {
        return;
    }
    player.startup_sync_start_position = startup_start_position(details, player.hls.config.liveSyncDuration);
}

function seek_video_to_start_position(video, start_position) {
    if (!video || typeof start_position !== "number" || !isFinite(start_position)) {
        return;
    }
    try {
        var seekable = video.seekable;
        if (!seekable || !seekable.length) {
            return;
        }
        for (var i = 0; i < seekable.length; i++) {
            if (seekable.start(i) <= start_position && start_position <= seekable.end(i)) {
                if (Math.abs((video.currentTime || 0) - start_position) > 0.25) {
                    video.currentTime = start_position;
                }
                return;
            }
        }
    } catch (e) {}
}

function apply_startup_start_position(player) {
    if (!player || !player.hls) {
        return;
    }
    var start_position = player.startup_sync_start_position;
    if (typeof start_position !== "number" || !isFinite(start_position)) {
        return;
    }
    try {
        if (typeof player.hls.stopLoad === "function") {
            player.hls.stopLoad();
        }
        if (typeof player.hls.startLoad === "function") {
            player.hls.startLoad(start_position);
        }
    } catch (e) {}
    seek_video_to_start_position(player.video, start_position);
    sync_debug_log("startup-start", {
        name: player.name,
        position: Number(start_position.toFixed(3)),
        liveSyncDuration: player.hls.config && player.hls.config.liveSyncDuration
    });
}

function startup_entry_buffer_ready(entry) {
    if (!entry || !entry.player || !entry.player.video) {
        return false;
    }
    var buffered = player_buffered_ahead(entry.player.video);
    if (buffered === null) {
        return false;
    }
    return buffered >= Math.max(STARTUP_SYNC_MIN_BUFFER, details_segment_duration(entry.details) || 0);
}

function startup_entries_have_buffer(entries) {
    if (!entries || !entries.length) {
        return false;
    }
    for (var i = 0; i < entries.length; i++) {
        if (!startup_entry_buffer_ready(entries[i])) {
            return false;
        }
    }
    return true;
}

function release_startup_sync_players(entries, use_startup_fallback) {
    entries = entries || startup_sync_ready_players();
    var target = startup_sync_target_pdt(entries, use_startup_fallback);
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var edge = details_edge_pdt(entry.details);
        if (target !== null && edge !== null && entry.player.hls && entry.player.hls.config) {
            var desired = (edge - target) / 1000;
            var floor = use_startup_fallback
                ? details_startup_latency_seconds(entry.details)
                : details_holdback_seconds(entry.details);
            if (isFinite(desired)) {
                entry.player.hls.config.liveSyncDuration = Math.max(
                    floor,
                    Math.min(details_holdback_seconds(entry.details) + CONVERGENCE_STRAGGLER_LIMIT, desired)
                );
            }
        }
        remember_startup_start_position(entry.player, entry.details);
        release_startup_player(entry.player);
    }
    if (startup_sync_timer && !startup_sync_ready_players().length) {
        clearTimeout(startup_sync_timer);
        startup_sync_timer = null;
    }
}

function maybe_release_startup_sync() {
    var entries = startup_sync_ready_players();
    if (!entries.length) {
        return;
    }
    if (!startup_sync_waiting_for_loads() && !startup_sync_has_unready_players()) {
        if (startup_entries_have_buffer(entries)) {
            release_startup_sync_players(entries, false);
        }
    }
}

function schedule_startup_sync_release() {
    maybe_release_startup_sync();
    if (startup_sync_timer) {
        return;
    }
    startup_sync_timer = setTimeout(function() {
        startup_sync_timer = null;
        release_startup_sync_players(null, true);
    }, STARTUP_SYNC_COORDINATION_WINDOW);
}

function coordinate_startup_toward_wall(name, hls, details) {
    var player = stream_players[name];
    if (!player || player.hls !== hls || !player.startup_pending || !hls.config) {
        return;
    }
    player.startup_sync_details = details || null;
    player.startup_sync_ready = !!details;

    var target_pdt = convergence_target_pdt();
    bias_startup_toward_wall(name, hls, details);
    if (target_pdt !== null) {
        release_startup_player(player);
        return;
    }
    schedule_startup_sync_release();
}

// Born converged: hls.js starts a fresh stream CONVERGENCE_HOLDBACK behind its
// own edge, but the shared wall may sit further back (a slower channel anchors
// the group), which would leave the newcomer ahead of the wall, drifting back
// at 0.95x for a minute. Raise this instance's hold-back and remember the
// matching media timeline position so release can actively restart loading
// there instead of merely delaying play() after hls.js has picked a fragment.
function bias_startup_toward_wall(name, hls, details) {
    var player = stream_players[name];
    if (!player || player.hls !== hls || !player.startup_pending || !hls.config) {
        return;
    }
    var edge_pdt = details_edge_pdt(details);
    if (edge_pdt === null ||
        Math.abs(edge_pdt - Date.now()) > CONVERGENCE_PDT_SANITY_LIMIT * 1000) {
        return;
    }
    var target_pdt = convergence_target_pdt();
    var startup_latency = details_startup_latency_seconds(details);
    if (target_pdt === null) {
        hls.config.liveSyncDuration = startup_latency;
        remember_startup_start_position(player, details);
        return;
    }
    var desired = (edge_pdt - target_pdt) / 1000;
    if (!isFinite(desired)) {
        return;
    }
    // Never start closer than the startup hold-back (smooth-start floor);
    // never chase a stalled group further back than the straggler limit.
    hls.config.liveSyncDuration = Math.max(startup_latency,
        Math.min(details_holdback_seconds(details) + CONVERGENCE_STRAGGLER_LIMIT, desired));
    remember_startup_start_position(player, details);
}

function run_convergence() {
    if (convergence_disabled || !page_active()) {
        return;
    }
    var players = collect_convergence_players();
    if (!players.length) {
        return;
    }
    update_convergence_straggler_states(players);
    var target_pdt = compute_convergence_target_for_players(players);
    var now = Date.now();
    for (var i = 0; i < players.length; i++) {
        var entry = players[i];
        var video = entry.player.video;
        try {
            var behind;
            if (target_pdt !== null && entry.playing_pdt !== null && entry.edge_pdt !== null) {
                behind = (target_pdt - entry.playing_pdt) / 1000;
                // Physical clamp: however the cross-stream math works out
                // (straggler exclusion, edge-offset asymmetries between
                // prefetch and non-prefetch channels), a stream can never be
                // asked to play closer than the holdback to its own edge --
                // that zone is inside the delivery frontier and only starves.
                var own_latency = measure_player_latency(entry.player);
                if (own_latency !== null) {
                    behind = Math.min(behind, own_latency - entry.holdback_seconds);
                }
            } else {
                // No usable PDT -> this stream can't wall-clock align; hold it
                // near its own live edge instead.
                var latency = measure_player_latency(entry.player);
                if (latency === null) {
                    continue;
                }
                behind = latency - entry.holdback_seconds;
            }
            var bounds = player_seek_bounds(entry.player);
            if (!bounds) {
                continue;
            }
            var correction = convergence_correction(behind, video.currentTime || 0,
                bounds.start, bounds.end, player_buffered_ahead(video), entry.min_buffer_seconds);
            if (correction.seek_to !== null) {
                video.playbackRate = 1;
                if (now - (entry.player.last_convergence_seek_at || 0) >= CONVERGENCE_SEEK_COOLDOWN) {
                    video.currentTime = correction.seek_to;
                    entry.player.last_convergence_seek_at = now;
                }
            } else {
                video.playbackRate = correction.playback_rate;
            }
            sync_debug_log("tick", {
                name: entry.name,
                behind: Number(behind.toFixed(3)),
                target: target_pdt,
                edgeGap: entry.edge_pdt === null ? null : Number(((Date.now() - entry.edge_pdt) / 1000).toFixed(3)),
                holdback: entry.holdback_seconds,
                buffer: player_buffered_ahead(video),
                rate: video.playbackRate,
                seek: correction.seek_to,
                straggler: !!entry.player.is_straggler
            });
        } catch (e) {
            try {
                video.playbackRate = 1;
            } catch (e2) {}
        }
    }
}

// Chromium flips document.hidden to true when the window is fully occluded
// (covered or minimized) or the tab is backgrounded -- exactly when it pauses
// muted video. A visible window on a second monitor stays "active" even while
// unfocused, so we deliberately do NOT key off window focus here.
function page_active() {
    return !document.hidden;
}

// Restart the loader from the live edge and seek the playhead to the shared
// convergence wall. Used after the player has fallen behind (tab/window
// backgrounded, manual jump-to-live). Snapping to the raw edge instead would
// start a fight the convergence tick wins two ticks later; targeting the wall
// makes ⟳ mean "re-align now". Falls back to just-behind-the-edge when no
// wall is computable (native engine, no PDT) -- a no-op when already there.
function snap_player_to_live(player) {
    if (!player || !player.video) {
        return;
    }
    try {
        if (player.hls && typeof player.hls.startLoad === "function") {
            player.hls.startLoad(-1);
        }
    } catch (e) {}
    try {
        var video = player.video;
        var seek_to = null;
        var target_pdt = convergence_target_pdt();
        var playing_pdt = player_playing_pdt(player);
        if (target_pdt !== null && playing_pdt !== null) {
            seek_to = (video.currentTime || 0) + (target_pdt - playing_pdt) / 1000;
        }
        var bounds = player_seek_bounds(player);
        if (!bounds) {
            return;
        }
        if (seek_to === null) {
            seek_to = bounds.end - 0.5;
        }
        seek_to = Math.max(bounds.start + 0.1, Math.min(bounds.end - 0.25, seek_to));
        if (Math.abs(seek_to - (video.currentTime || 0)) > 0.5) {
            video.currentTime = Math.max(0, seek_to);
        }
    } catch (e) {}
}

// Coming back to the foreground: nudge paused players back to play and reset
// stall tracking so the background gap isn't mistaken for a freeze. Browsers
// pause muted background video, so on return the players are stuck wherever they
// were -- snap them back to live; the convergence tick then settles everyone
// onto the shared wall.
function resume_all_after_inactive() {
    if (!page_active()) {
        return;
    }
    for (var name in stream_players) {
        if (!Object.prototype.hasOwnProperty.call(stream_players, name)) {
            continue;
        }
        var player = stream_players[name];
        if (!player || player.manual_paused) {
            continue;
        }
        player.last_time = player.video.currentTime || 0;
        player.last_progress_at = Date.now();
        player.resume_blocked = false;
        // Only the players the browser actually paused in the background (muted
        // video) need recovering. A stream with audio keeps playing while we're
        // away, so it stays near live -- snapping it would restart its loader and
        // stall it. Leave playing streams alone.
        if (player.video.paused) {
            snap_player_to_live(player);
            safe_play(player.video);
        }
    }
}

function ensure_all_streams_playing() {
    if (!page_active()) {
        return;
    }
    for (var name in stream_players) {
        if (Object.prototype.hasOwnProperty.call(stream_players, name)) {
            ensure_stream_playing(name);
        }
    }
}

function ensure_stream_playing(name) {
    var player = stream_players[name];
    if (!player || player.manual_paused || player.recovering) {
        return;
    }
    if (!page_active()) {
        return;
    }
    var now = Date.now();
    var current_time = player.video.currentTime || 0;
    if (current_time > player.last_time + 0.05) {
        player.last_time = current_time;
        player.last_progress_at = now;
        player.stalled = false;
        update_stream_playback_state(name);
        return;
    }
    if (player.startup_pending && now - player.startup_started_at < 20000) {
        if (player.video.paused && player.video.readyState >= 2) {
            // Replay at the stream's intended audio state rather than force-muting.
            // If the browser refuses unmuted audio, safe_play() catches the
            // NotAllowedError and drops us to muted + re-locked; a later tick then
            // sees the muted target and keeps video flowing. This preserves
            // unmuted autoplay where the browser allows it.
            play_stream_with_target_audio(name, player.video);
        }
        return;
    }
    player.startup_pending = false;
    if (resume_muted_after_blocked_audio(player)) {
        return;
    }
    var no_progress = now - player.last_progress_at > 8000;
    if (player.video.paused) {
        if (player.resume_blocked) {
            return;
        }
        attempt_stream_resume(name);
    } else if (player.stalled || no_progress) {
        mark_stream_stalled(name, "Reconnecting stream...");
        reload_stream_playback(name);
    }
}

function attempt_stream_resume(name) {
    var player = stream_players[name];
    if (!player || player.manual_paused || player.recovering || player.resume_timer) {
        return;
    }
    player.stalled = true;
    player.resume_blocked = false;
    var resume_start_time = player.video.currentTime || 0;
    set_player_status(stream_tile_by_name(name), "Resuming stream...");
    if (player.hls) {
        try {
            player.hls.startLoad(-1);
        } catch (e) {}
    }
    try {
        if (player.video.seekable && player.video.seekable.length) {
            var live_edge = player.video.seekable.end(player.video.seekable.length - 1);
            if (live_edge - player.video.currentTime > 3) {
                player.video.currentTime = Math.max(0, live_edge - 1);
                resume_start_time = player.video.currentTime;
            }
        }
    } catch (e) {}
    safe_play(player.video);
    update_stream_playback_state(name);
    player.resume_timer = setTimeout(function() {
        var current = stream_players[name];
        if (!current) {
            return;
        }
        current.resume_timer = null;
        var advanced = (current.video.currentTime || 0) > resume_start_time + 0.05;
        if (advanced && !current.video.paused) {
            current.stalled = false;
            current.last_time = current.video.currentTime;
            current.last_progress_at = Date.now();
            set_player_status(stream_tile_by_name(name), "");
            update_stream_playback_state(name);
            return;
        }
        if (resume_muted_after_blocked_audio(current)) {
            current.stalled = false;
            current.last_progress_at = Date.now();
            set_player_status(stream_tile_by_name(name), "");
            update_stream_playback_state(name);
            return;
        }
        if (media_is_ready_but_paused(current.video)) {
            current.stalled = false;
            current.resume_blocked = true;
            current.last_progress_at = Date.now();
            set_player_status(stream_tile_by_name(name), "Paused by browser. Press play to resume.");
            update_stream_playback_state(name);
            return;
        }
        mark_stream_stalled(name, "Reconnecting stream...");
        reload_stream_playback(name);
    }, 2500);
}

function resume_muted_after_blocked_audio(player) {
    if (!player || !player.video || !player.video.paused || player.video.muted) {
        return false;
    }
    if (!recent_audible_play_block(player)) {
        return false;
    }
    audio_unlocked = false;
    set_video_muted(player.video, true);
    player.video.volume = 0.0;
    update_mute_button();
    update_volume_display();
    if (!player.muted_resume_timer) {
        player.muted_resume_timer = setTimeout(function() {
            player.muted_resume_timer = null;
            if (!player.manual_paused && player.video.paused && player.video.muted) {
                safe_play(player.video);
            }
        }, 100);
    }
    return true;
}

function recent_audible_play_block(player) {
    return !!(player && player.last_audible_play_blocked_at &&
        Date.now() - player.last_audible_play_blocked_at < 3000);
}

function media_is_ready_but_paused(video) {
    return !!(video && video.paused && !video.error && video.readyState >= 2);
}

function mark_stream_stalled(name, message) {
    var player = stream_players[name];
    if (!player) {
        return;
    }
    if (player.resume_timer) {
        clearTimeout(player.resume_timer);
        player.resume_timer = null;
    }
    player.stalled = true;
    update_stream_playback_state(name);
    if (message) {
        set_player_status(stream_tile_by_name(name), message);
    }
}

function reload_stream_playback(name) {
    var player = stream_players[name];
    if (!player || player.recovering || player.manual_paused) {
        return;
    }
    player.recovering = true;
    player.stalled = true;
    if (player.recovery_timer) {
        clearTimeout(player.recovery_timer);
        player.recovery_timer = null;
    }
    if (player.resume_timer) {
        clearTimeout(player.resume_timer);
        player.resume_timer = null;
    }
    load_direct_stream(stream_tile_by_name(name), name, true);
}

function schedule_stream_recovery(name) {
    var player = stream_players[name];
    if (!player || player.manual_paused || player.recovery_timer) {
        return;
    }
    player.recovery_attempt += 1;
    var delay = Math.min(1000 * Math.pow(2, player.recovery_attempt - 1), 10000);
    player.recovery_timer = setTimeout(function() {
        var current = stream_players[name];
        if (!current) {
            return;
        }
        current.recovery_timer = null;
        current.recovering = false;
        reload_stream_playback(name);
    }, delay);
}

// Jump a drifted stream back to the live edge. Live multi-streams buffer at
// different points; this snaps to the seekable end (and nudges hls.js to
// resume loading) so the user can re-sync a tile that's fallen behind.
function sync_to_live(name, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    reveal_tile_controls(stream_tile_by_name(name));
    var player = stream_players[name];
    if (!player || !player.video) {
        load_direct_stream(stream_tile_by_name(name), name, true);
        return;
    }
    var video = player.video;
    player.manual_paused = false;
    player.recovering = false;
    snap_player_to_live(player);
    safe_play(video);
    update_stream_playback_state(name);
}

function toggle_stream_playback(name, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    reveal_tile_controls(stream_tile_by_name(name));
    var player = stream_players[name];
    if (!player) {
        load_direct_stream(stream_tile_by_name(name), name, true);
        return;
    }
    var should_resume = player.manual_paused || player.stalled || player.video.paused;
    if (should_resume) {
        player.manual_paused = false;
        player.recovering = false;
        player.stalled = false;
        player.resume_blocked = false;
        attempt_stream_resume(name);
    } else {
        player.manual_paused = true;
        player.video.pause();
    }
    update_stream_playback_state(name);
}

function update_stream_playback_state(name) {
    var player = stream_players[name];
    var paused = !!(player && (player.manual_paused || player.stalled || player.video.paused));
    var tile = stream_tile_by_name(name).toggleClass("is_paused", paused);
    tile.find(".stream_playback_button")
        .text(paused ? "\u25B6" : "\u275A\u275A")
        .attr("aria-label", (paused ? "Resume " : "Pause ") + name)
        .attr("title", paused ? "Resume" : "Pause");
}

function safe_play(video) {
    try {
        var play_promise = video.play();
        if (play_promise && play_promise.catch) {
            play_promise.catch(function(error) {
                if (audio_restore_pending && !video.muted && error && error.name === "NotAllowedError") {
                    handle_blocked_audible_play(video);
                }
            });
        }
    } catch (e) {}
}

function handle_blocked_audible_play(video) {
    var player = player_for_video(video);
    if (player) {
        player.last_audible_play_blocked_at = Date.now();
    }
    audio_restore_pending = false;
    audio_unlocked = false;
    set_video_muted(video, true);
    video.volume = 0.0;
    update_mute_button();
    update_volume_display();
    sync_active_stream_audio();
}

function player_for_video(video) {
    for (var name in stream_players) {
        if (Object.prototype.hasOwnProperty.call(stream_players, name) &&
            stream_players[name] && stream_players[name].video === video) {
            return stream_players[name];
        }
    }
    return null;
}

function play_stream_with_target_audio(name, video) {
    var target = stream_audio_target(name);
    apply_video_audio(video, !target.muted, target.volume);
}

function set_video_muted(video, muted) {
    muted = !!muted;
    // defaultMuted mirrors the HTML `muted` attribute. Keep it aligned with the
    // current property so Edge cannot restore a stale default on source attach.
    video.defaultMuted = muted;
    if (muted) {
        if (video.setAttribute) {
            video.setAttribute("muted", "");
        }
    } else if (video.removeAttribute) {
        video.removeAttribute("muted");
    }
    video.muted = muted;
}

function apply_video_audio(video, unmuted, volume) {
    if (volume === undefined) {
        volume = master_volume;
    }
    if (!unmuted) {
        set_video_muted(video, true);
        video.volume = 0.0;
        safe_play(video);
        return;
    }
    // Attempt a genuine audible play. We deliberately do NOT use the older
    // "play muted, then unmute on the resolved promise" trick: a muted play()
    // always resolves, so it hid real autoplay refusals from safe_play, and the
    // later unmute-without-gesture made the browser silently pause the element --
    // spawning a play -> unmute -> pause loop that stuttered video at the live
    // edge and never reached the muted fallback. Unmuting up front lets a blocked
    // play() reject with NotAllowedError, which safe_play catches and drops us to
    // muted + re-locked; where the browser allows sound, it just plays audibly.
    video.volume = volume;
    set_video_muted(video, false);
    safe_play(video);
}

function set_master_volume(value) {
    var pct = parseInt(value, 10);
    if (isNaN(pct)) {
        return;
    }
    pct = Math.max(0, Math.min(100, pct));
    audio_restore_pending = false;
    audio_unlocked = true;
    master_volume = pct / 100;
    master_muted = pct == 0;
    update_volume_display();
    update_mute_button();
    persist_audio_settings();
    propagate_master_volume_to_following();
    sync_active_stream_audio();
}

function toggle_master_mute() {
    audio_restore_pending = false;
    if (!audio_unlocked && !master_muted) {
        unlock_audio();
        return;
    }
    master_muted = !master_muted;
    if (!master_muted) {
        audio_unlocked = true;
    }
    update_mute_button();
    update_volume_display();
    persist_audio_settings();
    sync_active_stream_audio();
}

function update_mute_button() {
    var effectively_muted = master_muted || !audio_unlocked;
    var label = effectively_muted ? "Unmute" : "Mute";
    $("#mute_button")
        .text(effectively_muted ? "\uD83D\uDD07" : "\uD83D\uDD0A")
        .attr("aria-label", label)
        .attr("title", label);
}

function update_volume_display() {
    var pct = Math.round(master_volume * 100);
    // Match the mute button: a browser-blocked (re-locked) audio state reads as
    // muted even though master_muted is still false, so the readout reflects what
    // is actually heard rather than the saved percentage.
    var effectively_muted = master_muted || !audio_unlocked;
    $("#volume_slider").val(pct);
    $("#volume_value").text(effectively_muted ? "Muted" : pct + "%");
    $("#volume_slider").closest(".slider_row").toggleClass("is_muted", effectively_muted);
}

function destroy_stream_player(name) {
    var player = stream_players[name];
    if (!player) {
        delete stream_load_pending[name];
        return;
    }
    try {
        if (player.video) {
            player.video.playbackRate = 1;
        }
        if (player.recovery_timer) {
            clearTimeout(player.recovery_timer);
        }
        if (player.resume_timer) {
            clearTimeout(player.resume_timer);
        }
        if (player.muted_resume_timer) {
            clearTimeout(player.muted_resume_timer);
        }
        if (player.native_fallback_timer) {
            clearTimeout(player.native_fallback_timer);
        }
        if (player.hls) {
            player.hls.destroy();
        }
    } catch (e) {}
    delete stream_load_pending[name];
    delete stream_players[name];
    update_stream_straggler_badge(name, false);
    maybe_release_startup_sync();
}

function set_player_status(tile, message) {
    var status = tile.find(".stream_status");
    if (!message) {
        status.remove();
        return;
    }
    if (status.length == 0) {
        status = $("<div>", {"class": "stream_status"}).appendTo(tile);
    }
    status.text(message);
}

function initialize_stream_sorting() {
    $("#streams").sortable({
        handle: ".stream_hitbox",
        helper: "clone",
        items: ".stream",
        opacity: 0.85,
        placeholder: "stream_sort_placeholder",
        scroll: false,
        tolerance: "pointer",
        start: function(event, ui) {
            stream_dragging = true;
            stream_drag_name = ui.item.attr("data-stream");
            stream_drag_order = streams.slice();
            stream_drag_pointer = pointer_from_event(event);
            stream_drag_target_name = null;
            sync_sortable_preview_size(ui);
        },
        sort: function(event, ui) {
            stream_drag_pointer = pointer_from_event(event);
            stream_drag_target_name = stream_name_under_pointer(stream_drag_pointer, stream_drag_name);
            sync_sortable_preview_size(ui);
        },
        change: function(event, ui) {
            stream_drag_pointer = pointer_from_event(event);
            stream_drag_target_name = stream_name_under_pointer(stream_drag_pointer, stream_drag_name);
            sync_sortable_preview_size(ui);
        },
        update: function() {
            sync_stream_order_from_dom();
        },
        stop: function(event) {
            stream_drag_pointer = pointer_from_event(event) || stream_drag_pointer;
            setTimeout(function() {
                stream_dragging = false;
                stream_drag_name = null;
                stream_drag_order = null;
                stream_drag_pointer = null;
                stream_drag_target_name = null;
            }, 0);
        }
    });
}

function sync_sortable_preview_size(ui) {
    if (!ui || !ui.placeholder || !ui.placeholder.length) {
        return;
    }
    var slot_index = sortable_placeholder_index(ui.placeholder);
    var slot_size = sortable_slot_size(slot_index);
    if (!slot_size) {
        return;
    }
    ui.placeholder.width(slot_size.w).height(slot_size.h);
    if (ui.helper && ui.helper.length) {
        ui.helper.width(slot_size.w).height(slot_size.h);
    }
}

function sortable_placeholder_index(placeholder) {
    var children = $("#streams").children(".stream, .stream_sort_placeholder").filter(function() {
        return !$(this).hasClass("ui-sortable-helper");
    });
    var index = children.index(placeholder);
    return index < 0 ? 0 : index;
}

function sortable_slot_size(index) {
    var tiles = stream_tiles_for_state();
    if (!tiles.length) {
        return null;
    }
    var main_count = main_tile_count();
    var selector = main_count > 0 && index < main_count ? ".is_main" : ":not(.is_main)";
    var reference = tiles.filter(selector).first();
    if (!reference.length) {
        reference = tiles.first();
    }
    return {w: reference.width(), h: reference.height()};
}

function load_saved_chat_width() {
    try {
        var value = parseInt(localStorage.getItem("multitwitch_chat_width"), 10);
        return isNaN(value) ? null : value;
    } catch (e) {
        return null;
    }
}

function save_chat_width(width) {
    try {
        localStorage.setItem("multitwitch_chat_width", String(Math.round(width)));
    } catch (e) {}
}

function clamp_chat_width(width, wrapper_width, min_width, max_width) {
    var max_allowed = Math.max(min_width, Math.min(max_width, wrapper_width - MIN_STREAMS_WIDTH - 5));
    return Math.max(min_width, Math.min(max_allowed, Math.round(width)));
}

function initialize_chat_resizer() {
    var handle = $("#chat_resize_handle");
    if (!handle.length) {
        return;
    }
    handle.on("mousedown.chatresize", function(event) {
        var chatbox = $("#chatbox");
        chat_resizing = true;
        chat_resize_grab_offset = event.pageX - chatbox.offset().left;
        chat_resize_right = chatbox.offset().left + chatbox.outerWidth();
        $("body").addClass("chat_resizing");
        event.preventDefault();
    });
    $(document).on("mousemove.chatresize", function(event) {
        if (!chat_resizing) {
            return;
        }
        var wrapper_width = $("#watch_area").width();
        var chatbox = $("#chatbox");
        var desired_left = event.pageX - chat_resize_grab_offset;
        var desired_outer_width = chat_resize_right - desired_left;
        var chat_chrome = chatbox.outerWidth() - chatbox.width();
        var desired = desired_outer_width - chat_chrome;
        chat_width_override = clamp_chat_width(desired, wrapper_width, theater_mode ? 260 : 240, theater_mode ? 420 : 560);
        optimize_size(-1);
        event.preventDefault();
    }).on("mouseup.chatresize", function() {
        if (!chat_resizing) {
            return;
        }
        chat_resizing = false;
        save_chat_width(chat_width_override);
        $("body").removeClass("chat_resizing");
    });
}

function pointer_from_event(event) {
    if (!event) {
        return null;
    }
    if (typeof event.pageX == "number" && typeof event.pageY == "number") {
        return {page_x: event.pageX, page_y: event.pageY};
    }
    if (event.originalEvent) {
        return pointer_from_event(event.originalEvent);
    }
    return null;
}

function stream_name_under_pointer(pointer, exclude_name) {
    if (!pointer) {
        return null;
    }
    var viewport_x = pointer.page_x - $(window).scrollLeft();
    var viewport_y = pointer.page_y - $(window).scrollTop();
    var target = null;
    stream_tiles_for_state().each(function() {
        var tile = $(this);
        var name = tile.attr("data-stream");
        if (!name || name == exclude_name) {
            return;
        }
        var rect = this.getBoundingClientRect();
        if (viewport_x >= rect.left && viewport_x <= rect.right && viewport_y >= rect.top && viewport_y <= rect.bottom) {
            target = name;
            return false;
        }
    });
    return target;
}

function apply_stream_drop_replacement() {
    if (!stream_drag_order || !stream_drag_name) {
        sync_stream_order_from_dom();
        return;
    }
    var target_name = stream_drag_target_name || stream_name_under_pointer(stream_drag_pointer, stream_drag_name);
    var next_order = stream_drag_order.slice();
    var from_index = next_order.indexOf(stream_drag_name);
    var target_index = target_name ? next_order.indexOf(target_name) : -1;
    if (from_index != -1 && target_index != -1 && from_index != target_index) {
        next_order[from_index] = target_name;
        next_order[target_index] = stream_drag_name;
    }
    reorder_stream_tiles(next_order);
    sync_stream_order_from_dom();
}

function reorder_stream_tiles(order) {
    var container = $("#streams");
    $("#focus_break").detach();
    for (var i = 0; i < order.length; i++) {
        var tile = stream_tile_by_name(order[i]);
        if (tile.length) {
            container.append(tile);
        }
    }
}

function sync_stream_order_from_dom() {
    var previous_streams = streams.slice();
    streams = stream_tiles_for_state().map(function() {
        return $(this).attr("data-stream");
    }).get();
    // Keep the chosen audio stream; only fall back if it's no longer present.
    if (streams.indexOf(active_stream) == -1) {
        active_stream = streams.length ? streams[0] : null;
    }
    if (!same_stream_order(previous_streams, streams)) {
        reorder_chat_for_streams();
        update_url();
    }
    sync_active_stream_audio();
    optimize_size(streams.length);
    update_all_stream_tile_metadata();
}

function stream_tiles_for_state() {
    return $("#streams .stream").filter(function() {
        return !$(this).hasClass("ui-sortable-helper") &&
            !$(this).hasClass("ui-sortable-placeholder") &&
            !$(this).hasClass("stream_sort_placeholder");
    });
}

function same_stream_order(left, right) {
    if (left.length != right.length) {
        return false;
    }
    for (var i = 0; i < left.length; i++) {
        if (left[i] != right[i]) {
            return false;
        }
    }
    return true;
}

function reorder_chat_for_streams() {
    var tablist = $("#tablist");
    for (var i = 0; i < streams.length; i++) {
        var stream = streams[i];
        tablist.append(tablist.find("a[href='#chat-" + stream + "']").parent());
    }
    chat_tabs.tabs("refresh");
}

function add_stream(name) {
    name = $.trim(name).toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(name) || streams.indexOf(name) != -1) {
        return false;
    }
    streams.push(name);
    if (!active_stream) {
        active_stream = name;
    }
    var tile = stream_object(name);
    $("#streams").append(tile);
    create_player_for_tile(tile);
    $("#chatbox").append(chat_object(name));
    $("#tablist").append(chat_tab_object(name));
    chat_tabs.tabs("refresh");
    update_url();
    optimize_size(streams.length);
    render_followed_channels();
    render_presets();
    load_current_stream_metadata();
    auto_check_stream_together([name]);
    track_usage_event("stream_added");
    return true;
}

function update_url() {
    var new_url = "";
    for (var i = 0; i < streams.length; i++) {
        new_url = new_url + '/' + encodeURIComponent(streams[i]);
    }
    history.replaceState(null, "", new_url || "/");
}

function render_current_streams() {
    var list = $("#current_streams");
    if (list.length == 0) {
        return;
    }
    list.empty();
    if (streams.length == 0) {
        list.append($("<div>", {"class": "empty_state"}).text("No streams loaded."));
        return;
    }
    for (var i = 0; i < streams.length; i++) {
        var name = streams[i];
        // Click the name to make it the active audio stream; X removes it.
        // (The "Together" button is omitted while Stream Together is pinned.)
        var row = $("<div>", {"class": "current_stream"})
                .toggleClass("is_active", name == active_stream)
                .append($("<span>", {"class": "current_stream_name"}).text(name).click((function(stream_name) {
                    return function() {
                        set_active_stream(stream_name);
                    };
                })(name)));
        if (twitch_user && followed_channels_loaded && !is_followed_channel(name)) {
            row.append($("<button>", {
                type: "button",
                "class": "follow_stream",
                "aria-label": "Follow " + name + " on Twitch",
                title: "Follow on Twitch",
                text: "+ Follow"
            }).click((function(stream_name) {
                return function() {
                    open_follow_on_twitch(stream_name);
                };
            })(name)));
        }
        row.append($("<button>", {
                    type: "button",
                    "class": "remove_stream",
                    "aria-label": "Remove " + name,
                    title: "Remove",
                    text: "×"
                }).click((function(stream_name) {
                    return function() {
                        remove_stream(stream_name);
                    };
                })(name)));
        list.append(row);
    }
}

function is_followed_channel(name) {
    var login = String(name || "").toLowerCase();
    for (var i = 0; i < followed_channels.length; i++) {
        if (String(followed_channels[i].broadcaster_login || "").toLowerCase() === login) {
            return true;
        }
    }
    return false;
}

function open_follow_on_twitch(name) {
    if (!/^[A-Za-z0-9_]{1,25}$/.test(name || "")) {
        return;
    }
    follow_refresh_pending = true;
    window.open("https://www.twitch.tv/" + encodeURIComponent(name), "_blank", "noopener,noreferrer");
}

function initialize_follow_refresh() {
    window.addEventListener("focus", function() {
        if (follow_refresh_pending && twitch_user) {
            follow_refresh_pending = false;
            load_followed_channels();
        }
    });
}

function render_stream_together_actions() {
    var actions = $("#stream_together_actions");
    if (actions.length == 0) {
        return;
    }
    actions.empty();
    if (streams.length) {
        actions.append($("<button>", {
            type: "button",
            "class": "mini_button",
            text: "Recheck loaded streams"
        }).click(recheck_stream_together));
    }
}

// Generic collapsible panel (Presets). Stream Together has its own variant
// because it also manages the match-highlight state.
function toggle_panel_collapsed(panel_id) {
    set_panel_collapsed(panel_id, !$("#" + panel_id).hasClass("is_collapsed"));
}

function set_panel_collapsed(panel_id, collapsed) {
    var panel = $("#" + panel_id);
    panel.toggleClass("is_collapsed", collapsed);
    panel.find(".collapsible_body").prop("hidden", collapsed);
    panel.find(".collapsible_header")
        .attr("aria-expanded", collapsed ? "false" : "true")
        .find(".disclosure_chevron").text(collapsed ? "›" : "⌄");
}

function initialize_stream_together_panel() {
    set_stream_together_collapsed(true);
}

function toggle_stream_together_panel() {
    set_stream_together_collapsed(!$("#stream_together_panel").hasClass("is_collapsed"));
}

function set_stream_together_collapsed(collapsed) {
    $("#stream_together_panel").toggleClass("is_collapsed", collapsed);
    $("#stream_together_body").prop("hidden", collapsed);
    $("#stream_together_toggle").attr("aria-expanded", collapsed ? "false" : "true");
    $("#stream_together_toggle .disclosure_chevron").text(collapsed ? "\u203A" : "\u2304");
    if (!collapsed) {
        stream_together_matches_acknowledged = true;
        $("#stream_together_panel").removeClass("has_matches");
    }
}

function should_highlight_stream_together(has_matches) {
    if (!has_matches) {
        stream_together_matches_acknowledged = false;
    }
    return has_matches && !stream_together_matches_acknowledged;
}

function render_stream_together_results() {
    var container = $("#stream_together_results").empty();
    var matches = {};
    for (var source in stream_together_results) {
        if (!Object.prototype.hasOwnProperty.call(stream_together_results, source)) {
            continue;
        }
        var source_results = stream_together_results[source] || [];
        for (var i = 0; i < source_results.length; i++) {
            matches[source_results[i]] = true;
        }
    }
    $("#stream_together_panel").toggleClass(
        "has_matches",
        should_highlight_stream_together(Object.keys(matches).length > 0)
    );
    Object.keys(matches).sort().forEach(function(name) {
        var in_lineup = streams.indexOf(name) != -1;
        var item = $("<button>", {type: "button", "class": "follow_item stream_together_item"})
            .toggleClass("in_lineup", in_lineup)
            .append($("<span>", {"class": "follow_name", text: name}))
            .append($("<span>", {"class": "follow_meta", text: in_lineup ? "Added" : "Add"}));
        if (in_lineup) {
            item.prop("disabled", true);
        } else {
            item.click(function() {
                add_stream($(this).find(".follow_name").text());
            });
        }
        container.append(item);
    });
}

function recheck_stream_together() {
    stream_together_checked = {};
    stream_together_results = {};
    render_stream_together_results();
    set_stream_together_hint("Checking loaded streamers...");
    for (var i = 0; i < streams.length; i++) {
        load_stream_together(streams[i], false);
    }
}


function stream_tile_by_name(name) {
    return $("#streams .stream").filter(function() {
        return $(this).attr("data-stream") == name;
    });
}

function main_tile_count() {
    if (layout_mode == "focus-two" || layout_mode == "focus-two-vertical") {
        return 2;
    }
    if (layout_mode == "focus-one") {
        return 1;
    }
    return 0;
}

function update_main_markers() {
    var main_count = main_tile_count();
    $("#streams .stream").each(function(index) {
        $(this).toggleClass("is_main", main_count > 0 && index < main_count);
    });
}

// Promote a tile to the main (large) slot in focus layouts. This only changes
// the visual layout order -- the active audio stream is left untouched, so the
// audio can keep coming from a smaller tile (e.g. commentary over gameplay).
function set_main_stream(name) {
    var tile = stream_tile_by_name(name);
    if (!tile.length) {
        return;
    }
    $("#streams").prepend(tile);
    streams = $("#streams .stream").map(function() {
        return $(this).attr("data-stream");
    }).get();
    reorder_chat_for_streams();
    update_url();
    optimize_size(streams.length);
}

function set_layout_mode(mode) {
    layout_mode = mode;
    main_size_fraction = main_size_fractions[mode] || (mode == "focus-two" ? 1.0 : 0.0);
    $("#watch_area")
        .removeClass("layout-grid layout-focus-one layout-focus-two layout-focus-two-vertical")
        .addClass("layout-" + mode);
    $("[data-layout-button]").removeClass("is_selected").attr("aria-pressed", "false");
    $("[data-layout-button='" + mode + "']").addClass("is_selected").attr("aria-pressed", "true");
    $("#layout_state").text(layout_label(mode));
    sync_main_size_control();
    save_layout_mode(mode);
    optimize_size(-1);
    if (usage_events_ready) {
        track_usage_event("layout_changed");
    }
}

function layout_label(mode) {
    if (mode == "grid") {
        return "Grid";
    }
    if (mode == "focus-one") {
        return "1 Main";
    }
    if (mode == "focus-two-vertical") {
        return "2 Stack";
    }
    return "2 Wide";
}

function sync_main_size_control() {
    var pct = 0;
    var inactive = false;
    if (layout_mode == "grid") {
        pct = 0;
        inactive = true;
    } else if (layout_mode == "focus-two") {
        pct = 100;
        inactive = true;
    } else {
        pct = Math.round((main_size_fractions[layout_mode] || 0.70) * 100);
    }
    $("#main_size_row").toggleClass("inactive", inactive);
    $("#main_size_slider").prop("disabled", inactive).val(pct);
    $("#main_size_value").text(pct + "%");
}

function set_main_size(value) {
    if (layout_mode == "grid" || layout_mode == "focus-two") {
        sync_main_size_control();
        return;
    }
    var pct = parseInt(value, 10);
    if (isNaN(pct)) {
        return;
    }
    main_size_fraction = Math.min(1, Math.max(0, pct / 100));
    main_size_fractions[layout_mode] = main_size_fraction;
    $("#main_size_value").text(pct + "%");
    save_main_size_fractions();
    optimize_size(-1);
}

function toggle_theater_mode() {
    theater_mode = !theater_mode;
    sync_theater_mode();
    if (theater_mode) {
        show_theater_hint();
    }
    track_usage_event("theater_toggled");
}

function exit_theater_mode() {
    if (theater_mode) {
        theater_mode = false;
        sync_theater_mode();
    }
}

function toggle_theater_chat() {
    var toggle = $("#theater_chat_toggle");
    toggle.prop("checked", !toggle.prop("checked"));
    sync_theater_mode();
}

function sync_theater_mode() {
    var chat_on = $("#theater_chat_toggle").prop("checked");
    // Drop any inline display set by the auto-hide path so theater's CSS rules
    // (which show/hide chat) take over cleanly.
    $("#chatbox").css("display", "");
    $("body").toggleClass("theater_mode", theater_mode);
    $("body").toggleClass("theater_with_chat", theater_mode && chat_on && !chat_hidden);
    var chat_visible = chat_on && !chat_hidden;
    $("#theater_chat_button").toggleClass("is_selected", chat_visible).attr("aria-pressed", chat_visible ? "true" : "false").text(chat_visible ? "Hide Chat" : "Show Chat");
    // Reveal the controls on mouse movement (faint), only while in theater mode.
    $(document).off("mousemove.theater");
    clearTimeout(theater_pointer_timer);
    if (theater_mode) {
        $(document).on("mousemove.theater", bump_theater_pointer);
        bump_theater_pointer();
    } else {
        $("body").removeClass("theater_pointer_active");
    }
    optimize_size(-1);
}

var theater_pointer_timer = null;
function bump_theater_pointer() {
    $("body").addClass("theater_pointer_active");
    clearTimeout(theater_pointer_timer);
    theater_pointer_timer = setTimeout(function() {
        $("body").removeClass("theater_pointer_active");
    }, 2200);
}

function show_theater_hint() {
    var hint = $("#theater_hint");
    hint.addClass("is_visible");
    clearTimeout(hint.data("hide_timer"));
    hint.data("hide_timer", setTimeout(function() {
        hint.removeClass("is_visible");
    }, 3200));
}

function initialize_feedback() {
    $("#feedback_overlay").on("click", function(e) {
        if (e.target === this) {
            close_feedback_form();
        }
    });
}

function open_feedback_form() {
    feedback_open = true;
    $("#feedback_status").attr("class", "").text("");
    $("#feedback_message").val("");
    $("#feedback_email").val("");
    $("#feedback_overlay").addClass("visible");
    $("#feedback_message").focus();
    track_usage_event("feedback_opened");
}

function close_feedback_form() {
    feedback_open = false;
    $("#feedback_overlay").removeClass("visible");
}

function submit_feedback() {
    var message = $.trim($("#feedback_message").val());
    var email = $.trim($("#feedback_email").val());
    var $status = $("#feedback_status");

    if (!message) {
        $status.attr("class", "error").text("Please enter a message.");
        return;
    }

    var $submit = $("#feedback_submit");
    $submit.prop("disabled", true).text("Sending...");
    $status.attr("class", "").text("");

    $.ajax({
        url: "/api/feedback",
        type: "POST",
        data: {message: message, email: email},
        timeout: 15000,
        success: function() {
            $status.attr("class", "success").text("Thanks, sent!");
            setTimeout(close_feedback_form, 1400);
        },
        error: function(xhr) {
            var msg = (xhr.responseJSON && xhr.responseJSON.error) || "Could not send feedback right now.";
            $status.attr("class", "error").text(msg);
        },
        complete: function() {
            $submit.prop("disabled", false).text("Send");
        }
    });
}

function initialize_help_modal() {
    $("#help_overlay").on("click", function(e) {
        if (e.target === this) {
            close_help_modal();
        }
    });
}

function open_help_modal() {
    help_open = true;
    $("#help_overlay").addClass("visible");
}

function close_help_modal() {
    help_open = false;
    $("#help_overlay").removeClass("visible");
}

function initialize_touch() {
    try {
        is_touch_device = !!(window.matchMedia && window.matchMedia("(hover: none)").matches);
    } catch (e) {
        is_touch_device = false;
    }
    if (is_touch_device) {
        $("body").addClass("is_touch");
    }
}

// On touch, reveal a tile's hover-only controls for a few seconds. No-op on
// pointer devices, so it's safe to call from any tile interaction.
function reveal_tile_controls(tile) {
    if (!is_touch_device || !tile || !tile.length) {
        return;
    }
    tile.addClass("controls_visible");
    clearTimeout(tile.data("controls_timer"));
    tile.data("controls_timer", setTimeout(function() {
        tile.removeClass("controls_visible");
    }, 4000));
}

function initialize_keyboard() {
    // Track the tile under the cursor so fullscreen / picture-in-picture act on
    // the stream you're looking at, not just the audio source. Delegated so it
    // covers tiles added after load.
    $("#streams")
        .on("mouseenter.shortcut", ".stream", function() {
            hovered_stream = $(this).attr("data-stream");
        })
        .on("mouseleave.shortcut", ".stream", function() {
            if (hovered_stream === $(this).attr("data-stream")) {
                hovered_stream = null;
            }
        });
    $(document).on("keydown", function(e) {
        var key = e.key || "";
        var in_field = $(e.target).is("input, textarea, select");
        if (key === "Escape" || e.keyCode === 27) {
            if (feedback_open) {
                close_feedback_form();
                return;
            }
            if (help_open) {
                close_help_modal();
                return;
            }
            if (theater_mode) {
                exit_theater_mode();
            }
            return;
        }
        // Don't hijack typing, or browser/OS chords (Ctrl/Alt/Meta).
        if (in_field || e.ctrlKey || e.altKey || e.metaKey) {
            return;
        }
        if (key >= "1" && key <= "9") {
            var index = parseInt(key, 10) - 1;
            if (index < streams.length) {
                set_active_stream(streams[index]);
            }
            return;
        }
        if (key === "t" || key === "T") {
            toggle_theater_mode();
            return;
        }
        if (key === "c" || key === "C") {
            // Mirror whichever chat toggle is active for the current mode.
            if (theater_mode) {
                toggle_theater_chat();
            } else {
                toggle_chat();
            }
            return;
        }
        if (key === "f" || key === "F") {
            toggle_tile_fullscreen(target_shortcut_stream());
            return;
        }
        if (key === "p" || key === "P") {
            toggle_tile_pip(target_shortcut_stream());
            return;
        }
        if (key === "m" || key === "M") {
            toggle_master_mute();
            return;
        }
    });
}

// Fullscreen / PiP act on the hovered tile when there is one, otherwise the
// active audio stream -- so the shortcuts work both with and without a mouse.
function target_shortcut_stream() {
    if (hovered_stream && streams.indexOf(hovered_stream) != -1) {
        return hovered_stream;
    }
    return active_stream;
}

function toggle_tile_fullscreen(name) {
    if (document.fullscreenElement) {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
        return;
    }
    if (!name) {
        return;
    }
    var tile = stream_tile_by_name(name).get(0);
    if (tile && tile.requestFullscreen) {
        var promise = tile.requestFullscreen();
        if (promise && promise.catch) {
            promise.catch(function() {});
        }
    }
}

function toggle_tile_pip(name) {
    if (document.pictureInPictureElement) {
        if (document.exitPictureInPicture) {
            document.exitPictureInPicture().catch(function() {});
        }
        return;
    }
    if (!name) {
        return;
    }
    var player = stream_players[name];
    if (player && player.video && player.video.requestPictureInPicture) {
        var promise = player.video.requestPictureInPicture();
        if (promise && promise.catch) {
            promise.catch(function() {});
        }
    }
}

function initialize_twitch() {
    $.ajax({
        url: "/api/twitch/me",
        success: function(data) {
            if (!data.configured) {
                twitch_user = null;
                set_twitch_state("Setup", "setup");
                $("#twitch_connect_button").prop("disabled", true);
                $("#twitch_disconnect_button").hide();
                set_twitch_hint("Set twitch.client_id, twitch.client_secret, and twitch.redirect_uri in the app config.");
                load_current_stream_metadata();
                return;
            }

            $("#twitch_connect_button").prop("disabled", false);
            if (!data.connected) {
                twitch_user = null;
                followed_channels_loaded = false;
                render_current_streams();
                set_twitch_state("Offline", "offline");
                $("#twitch_disconnect_button").hide();
                set_twitch_hint(data.message || "Connect Twitch to load followed channels.");
                load_current_stream_metadata();
                return;
            }

            twitch_user = data;
            set_twitch_state(data.login, "connected");
            $("#twitch_disconnect_button").show();
            set_twitch_hint("Connected as " + data.login + ".");
            load_current_stream_metadata();
            load_followed_channels();
            if (notify_enabled) {
                start_go_live_polling();
            }
        },
        error: function() {
            set_twitch_state("Error", "error");
            set_twitch_hint("Could not check Twitch session.");
            load_current_stream_metadata();
        }
    });
}

function connect_twitch() {
    ensure_twitch_auth_listener();
    track_usage_event("twitch_connect_clicked");
    var return_to = window.location.pathname + window.location.search;
    // Authenticate in a popup so the main page -- and every loaded stream --
    // stays put. The callback closes the popup and posts back to us; we just
    // re-check the session. Fall back to a full-page redirect if blocked.
    var width = 520;
    var height = 720;
    var left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    var top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    var popup = window.open(
        "/auth/twitch/start?" + $.param({popup: 1, return_to: return_to}),
        "twitch_oauth",
        "width=" + width + ",height=" + height + ",left=" + left + ",top=" + top
    );
    if (!popup) {
        window.location.href = "/auth/twitch/start?" + $.param({return_to: return_to});
    }
}

var twitch_auth_listener_ready = false;
function ensure_twitch_auth_listener() {
    if (twitch_auth_listener_ready) {
        return;
    }
    twitch_auth_listener_ready = true;
    window.addEventListener("message", function(event) {
        if (event.origin === window.location.origin && event.data === "multitwitch-twitch-auth") {
            initialize_twitch();
        }
    });
}

function disconnect_twitch() {
    $.ajax({
        url: "/auth/twitch/logout",
        type: "POST",
        complete: function() {
            twitch_user = null;
            followed_channels = [];
            followed_channels_loaded = false;
            twitch_live_channels = {};
            $("#followed_channels").empty();
            $("#twitch_disconnect_button").hide();
            set_twitch_state("Offline", "offline");
            set_twitch_hint("Signed out.");
            stop_go_live_polling();
            notify_seeded = false;
            notify_seen_live = {};
            render_current_streams();
        }
    });
}

// Go-live desktop notifications. Polls followed-streams while enabled and
// connected; the first poll only seeds the known-live set so we don't fire for
// channels already live when notifications were turned on.
var GO_LIVE_NOTIFY_KEY = "multitwitch.notifyGoLive";
var notify_enabled = false;
var notify_poll_timer = null;
var notify_seeded = false;
var notify_seen_live = {};
var NOTIFY_POLL_INTERVAL = 120000;

function initialize_notifications() {
    try {
        notify_enabled = window.localStorage.getItem(GO_LIVE_NOTIFY_KEY) === "1";
    } catch (e) {}
    $("#notify_toggle").prop("checked", notify_enabled);
    if (notify_enabled && twitch_user) {
        start_go_live_polling();
    }
}

function toggle_go_live_notifications() {
    var on = $("#notify_toggle").prop("checked");
    if (!on) {
        set_notify_enabled(false);
        return;
    }
    if (!window.Notification) {
        $("#notify_toggle").prop("checked", false);
        set_twitch_hint("This browser does not support notifications.");
        return;
    }
    if (Notification.permission === "granted") {
        set_notify_enabled(true);
        return;
    }
    if (Notification.permission === "denied") {
        $("#notify_toggle").prop("checked", false);
        set_twitch_hint("Notifications are blocked in your browser settings.");
        return;
    }
    Notification.requestPermission().then(function(permission) {
        if (permission === "granted") {
            $("#notify_toggle").prop("checked", true);
            set_notify_enabled(true);
        } else {
            $("#notify_toggle").prop("checked", false);
            set_notify_enabled(false);
            set_twitch_hint("Notification permission was not granted.");
        }
    });
}

function set_notify_enabled(on) {
    notify_enabled = on;
    try {
        window.localStorage.setItem(GO_LIVE_NOTIFY_KEY, on ? "1" : "0");
    } catch (e) {}
    track_usage_event("notifications_toggled", {enabled: !!on});
    if (on) {
        start_go_live_polling();
    } else {
        stop_go_live_polling();
        notify_seeded = false;
        notify_seen_live = {};
    }
}

function start_go_live_polling() {
    if (notify_poll_timer) {
        return;
    }
    poll_go_live();
    notify_poll_timer = setInterval(poll_go_live, NOTIFY_POLL_INTERVAL);
}

function stop_go_live_polling() {
    if (notify_poll_timer) {
        clearInterval(notify_poll_timer);
        notify_poll_timer = null;
    }
}

function poll_go_live() {
    if (!twitch_user || !notify_enabled) {
        return;
    }
    twitch_api("followed-streams", {first: 100}, function(data) {
        var live = data.data || [];
        var now_live = index_live_streams(live);
        if (notify_seeded) {
            for (var login in now_live) {
                if (Object.prototype.hasOwnProperty.call(now_live, login) && !notify_seen_live[login]) {
                    show_go_live_notification(now_live[login]);
                }
            }
        } else {
            notify_seeded = true;
        }
        notify_seen_live = now_live;
        // Replace, rather than merge, so channels that ended since the previous
        // poll lose their stale Live marker in the followed list.
        twitch_live_channels = now_live;
        for (var key in now_live) {
            if (Object.prototype.hasOwnProperty.call(now_live, key)) {
                twitch_live_channels[key] = now_live[key];
            }
        }
        cache_stream_metadata(live);
        render_followed_channels();
    }, function() {});
}

function index_live_streams(live) {
    var indexed = {};
    for (var i = 0; i < (live || []).length; i++) {
        if (live[i].user_login) {
            indexed[live[i].user_login] = live[i];
        }
    }
    return indexed;
}

function show_go_live_notification(stream) {
    if (!window.Notification || Notification.permission !== "granted") {
        return;
    }
    var title = (stream.user_name || stream.user_login) + " is live";
    var body = stream.title || stream.game_name || "";
    try {
        var note = new Notification(title, {
            body: body,
            tag: "multitwitch-live-" + stream.user_login
        });
        note.onclick = function() {
            window.focus();
            add_stream(stream.user_login);
            note.close();
        };
    } catch (e) {}
}

function twitch_api(path, data, on_success, on_error) {
    if (!twitch_user) {
        set_twitch_hint("Connect Twitch first.");
        return;
    }
    $.ajax({
        url: "/api/twitch/" + path,
        data: data,
        traditional: true,
        success: on_success,
        error: on_error || function(xhr) {
            var message = (xhr.responseJSON && xhr.responseJSON.error) || "Twitch API error: " + xhr.status + ".";
            if (xhr.status == 401) {
                twitch_user = null;
                followed_channels = [];
                twitch_live_channels = {};
                $("#followed_channels").empty();
                $("#twitch_disconnect_button").hide();
                set_twitch_state("Offline", "offline");
                set_twitch_hint(message + " Connect Twitch again.");
                return;
            }
            if (xhr.status == 503) {
                set_twitch_state("Setup", "setup");
                set_twitch_hint(message);
                return;
            }
            set_twitch_hint(message);
        }
    });
}

function load_followed_channels() {
    if (!twitch_user) {
        set_twitch_hint("Connect Twitch to load followed channels.");
        return;
    }
    followed_channels = [];
    followed_channels_loaded = false;
    twitch_live_channels = {};
    set_twitch_hint("Loading followed channels...");
    load_followed_page(null);
}

function load_followed_page(cursor) {
    var params = {first: 100};
    if (cursor) {
        params.after = cursor;
    }
    twitch_api("follows", params, function(data) {
        followed_channels = followed_channels.concat(data.data || []);
        if (data.pagination && data.pagination.cursor && followed_channels.length < 1000) {
            load_followed_page(data.pagination.cursor);
        } else {
            followed_channels_loaded = true;
            load_followed_live_streams();
        }
    });
}

function load_followed_live_streams() {
    twitch_api("followed-streams", {first: 100}, function(data) {
        var live = data.data || [];
        for (var i = 0; i < live.length; i++) {
            twitch_live_channels[live[i].user_login] = live[i];
        }
        cache_stream_metadata(live);
        render_followed_channels();
        render_current_streams();
        update_all_stream_tile_metadata();
        set_twitch_hint("Loaded " + followed_channels.length + " followed channels.");
        track_usage_event("followed_channels_loaded");
    });
}

function render_followed_channels() {
    var container = $("#followed_channels");
    if (container.length == 0) {
        return;
    }
    var filter = $.trim($("#follow_filter").val() || "").toLowerCase();
    hide_follow_tooltip();
    container.empty();
    if (!followed_channels.length) {
        container.append($("<div>", {"class": "empty_state"}).text("No followed channels loaded."));
        return;
    }
    var channels = followed_channels.slice(0);
    channels.sort(function(a, b) {
        var a_live = twitch_live_channels[a.broadcaster_login] ? 1 : 0;
        var b_live = twitch_live_channels[b.broadcaster_login] ? 1 : 0;
        if (a_live != b_live) {
            return b_live - a_live;
        }
        return a.broadcaster_name.localeCompare(b.broadcaster_name);
    });
    var shown = 0;
    for (var i = 0; i < channels.length; i++) {
        var channel = channels[i];
        var login = channel.broadcaster_login;
        var name = channel.broadcaster_name;
        if (filter && login.indexOf(filter) == -1 && name.toLowerCase().indexOf(filter) == -1) {
            continue;
        }
        shown++;
        var live = twitch_live_channels[login];
        var in_lineup = streams.indexOf(login) != -1;
        var item = $("<button>", {type: "button", "class": "follow_item", disabled: in_lineup})
            .toggleClass("is_live", !!live)
            .toggleClass("in_lineup", in_lineup)
            .append($("<span>", {"class": "follow_name"}).text((in_lineup ? "(streaming) " : "") + name))
            .append($("<span>", {"class": "follow_meta"}).text(in_lineup ? "Added" : (live ? "Live" : "Followed")));
        if (!in_lineup) {
            item.click((function(stream_name) {
                return function() {
                    add_stream(stream_name);
                };
            })(login));
        }
        var shell = $("<div>", {"class": "follow_item_shell"});
        var tooltip = live_follow_tooltip(live);
        if (tooltip) {
            // Custom data attribute (not the native title) so our instant,
            // delay-free hover tooltip renders it -- see initialize_follow_tooltip.
            shell.attr("data-tooltip", tooltip);
        }
        container.append(shell.append(item));
        if (shown >= 80) {
            break;
        }
    }
    if (!shown) {
        container.append($("<div>", {"class": "empty_state"}).text("No matches."));
    }
}

function live_follow_tooltip(live) {
    if (!live) {
        return "";
    }
    var details = [];
    if (live.game_name) {
        details.push("Game: " + live.game_name);
    }
    if (live.title) {
        details.push("Title: " + live.title);
    }
    return details.join("\n");
}

// Followed-channel rows show their game/title on hover. We use a body-appended
// element rather than the native `title` attribute so it appears instantly (the
// browser's title tooltip has a built-in delay), and `position: fixed` so the
// list's overflow:auto scroll box doesn't clip it.
var follow_tooltip_el = null;

function follow_tooltip_node() {
    if (!follow_tooltip_el) {
        follow_tooltip_el = document.createElement("div");
        follow_tooltip_el.className = "hover_tooltip";
        document.body.appendChild(follow_tooltip_el);
    }
    return follow_tooltip_el;
}

function show_follow_tooltip(target) {
    var text = target.getAttribute("data-tooltip");
    if (!text) {
        return;
    }
    var node = follow_tooltip_node();
    node.textContent = text;
    node.style.display = "block";
    position_follow_tooltip(target);
}

function position_follow_tooltip(target) {
    if (!follow_tooltip_el) {
        return;
    }
    var node = follow_tooltip_el;
    var rect = target.getBoundingClientRect();
    var margin = 8;
    var width = node.offsetWidth;
    var height = node.offsetHeight;
    // The followed list lives in the sidebar; prefer placing the tooltip to the
    // left of the row, falling back to its right when there isn't room.
    var left = rect.left - margin - width;
    if (left < margin) {
        left = rect.right + margin;
    }
    if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - margin - width);
    }
    var top = rect.top + (rect.height - height) / 2;
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
}

function hide_follow_tooltip() {
    if (follow_tooltip_el) {
        follow_tooltip_el.style.display = "none";
    }
}

function initialize_follow_tooltip() {
    $("#followed_channels")
        .on("mouseenter.followtip", ".follow_item_shell", function() {
            show_follow_tooltip(this);
        })
        .on("mouseleave.followtip", ".follow_item_shell", hide_follow_tooltip)
        .on("scroll.followtip", hide_follow_tooltip);
}

function auto_check_stream_together(names) {
    for (var i = 0; i < names.length; i++) {
        load_stream_together(names[i], true);
    }
}

function load_stream_together(stream_name, automatic) {
    if (stream_together_inflight[stream_name] || (automatic && stream_together_checked[stream_name])) {
        return;
    }
    if (!automatic) {
        set_stream_together_hint("Checking " + stream_name + "...");
    }
    stream_together_inflight[stream_name] = $.ajax({
        url: "/api/twitch/stream-together",
        data: {login: stream_name},
        success: function(data) {
            stream_together_checked[stream_name] = true;
            var collaborators = data.streamers || [];
            var names = [];
            for (var i = 0; i < collaborators.length; i++) {
                if (collaborators[i].login && collaborators[i].login != "SCREENSHARE") {
                    var collaborator_name = collaborators[i].login.toLowerCase();
                    if (names.indexOf(collaborator_name) == -1) {
                        names.push(collaborator_name);
                    }
                }
            }
            stream_together_results[stream_name] = names;
            render_stream_together_results();
            if (names.length == 0) {
                if (!automatic) {
                    set_stream_together_hint("No live Stream Together collaborators were visible for " + stream_name + ".");
                }
                return;
            }
            set_stream_together_hint("Found " + names.join(", ") + ".");
        },
        error: function(xhr) {
            if (automatic) {
                return;
            }
            var message = (xhr.responseJSON && xhr.responseJSON.error) || "";
            if (message) {
                set_stream_together_hint(message);
            } else {
                set_stream_together_hint("Could not check Stream Together for " + stream_name + " (" + xhr.status + ").");
            }
        },
        complete: function() {
            delete stream_together_inflight[stream_name];
            render_stream_together_actions();
            render_stream_together_results();
        }
    });
}

function set_twitch_state(text, kind) {
    $("#twitch_auth_state")
        .text(text)
        .removeClass("state-connected state-offline state-setup state-error")
        .addClass("state-" + (kind || "offline"));
}

function set_twitch_hint(text) {
    $("#twitch_account_hint").text(text);
}

function set_stream_together_hint(text) {
    $("#stream_together_hint").text(text);
}

function render_app_version() {
    var brand = $("#brand_name");
    if (brand.length === 0) {
        return;
    }
    var label = $("#app_version");
    if (label.length === 0) {
        brand.append(" ");
        label = $("<span>", {id: "app_version"}).appendTo(brand);
    }
    label.text("v" + APP_VERSION);
    if (brand.find("#app_beta").length === 0) {
        brand.append(" ");
        $("<span>", {id: "app_beta", text: "Beta"}).appendTo(brand);
    }
}

// Render the version from the (hot-served) JS so a hard refresh shows it even if
// the dev server cached an older template.
$(render_app_version);
