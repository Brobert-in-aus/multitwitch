// Bump on each JS change. Rendered next to the title by the JS itself (not the
// server template), so a hard refresh always shows the version actually loaded
// -- even if the dev server cached an older home.tmpl.
var APP_VERSION = "58";
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
// Main-size slider positions by layout. Grid and 2-wide are fixed displays.
var main_size_fractions = {
    "focus-one": 0.70,
    "focus-two-vertical": 0.70
};
var main_size_fraction = main_size_fractions["focus-one"];
var active_border_timer = null;
var audio_unlocked = false;  // browsers block autoplay-with-sound until a gesture
var master_volume = 0.70;
var master_muted = true;
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
var quality_adapt_timer = null;
// Only re-pick quality once tiles have stopped resizing for this long, so
// dragging the main-size slider or a window edge doesn't thrash the players.
var QUALITY_ADAPT_DELAY = 10000;
var twitch_user = null;
var followed_channels = [];
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
    load_current_stream_metadata();
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
    })).append($("<div>", {
        "class": "stream_overlay stream_title",
        text: name
    })).append($("<div>", {
        "class": "stream_overlay stream_channel",
        text: name
    })).append($("<div>", {
        "class": "stream_overlay stream_game"
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
    $("#streams .stream").each(function() {
        var tile = $(this);
        if (!tile.attr("id")) {
            tile.attr("id", next_stream_tile_id());
        }
        create_stream_player(tile);
    });
    var saved_active = load_saved_active_stream();
    active_stream = (saved_active && streams.indexOf(saved_active) != -1)
        ? saved_active
        : (streams.length ? streams[0] : null);
    sync_active_stream_audio();
}

function create_stream_player(tile) {
    var name = tile.attr("data-stream");
    tile.find(".stream_hitbox").off("click.stream keydown.stream")
        .on("click.stream", function() {
            if (stream_dragging) {
                return;
            }
            set_active_stream(name);
        })
        .on("keydown.stream", function(e) {
            // The hitbox advertises role="button" -- honor Enter/Space activation.
            if (e.key === "Enter" || e.key === " " || e.keyCode === 13 || e.keyCode === 32) {
                e.preventDefault();
                set_active_stream(name);
            }
        });
    tile.attr("data-muted", "true");
    tile.find(".stream_player").empty().append(direct_player_element(name));
    update_stream_tile_metadata(tile);
    load_direct_stream(tile, name);
}

function create_player_for_tile(tile) {
    create_stream_player(tile);
    sync_active_stream_audio();
    load_current_stream_metadata();
}

function update_all_stream_tile_metadata() {
    $("#streams .stream").each(function() {
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
    if (!twitch_user || streams.length == 0) {
        update_all_stream_tile_metadata();
        return;
    }
    twitch_api("streams", {user_login: streams, first: 100}, function(data) {
        var live = data.data || [];
        for (var i = 0; i < live.length; i++) {
            stream_metadata[live[i].user_login.toLowerCase()] = live[i];
        }
        update_all_stream_tile_metadata();
    }, function() {
        update_all_stream_tile_metadata();
    });
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

    // A saved unmuted state records a previous user gesture. Restore that intent
    // so the active stream can be unmuted after its muted autoplay has started.
    audio_unlocked = !master_muted && master_volume > 0;
    update_volume_display();
    update_mute_button();
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
    if (audio_unlocked) {
        return;
    }
    audio_unlocked = true;
    sync_active_stream_audio();
}

function sync_active_stream_audio() {
    if (!active_stream && streams.length) {
        active_stream = streams[0];
    }
    $("#streams .stream").each(function() {
        var tile = $(this);
        var name = tile.attr("data-stream");
        var is_active = name == active_stream;
        // First-run and saved-muted sessions stay muted so video can autoplay.
        var unmuted = audio_unlocked && is_active && !master_muted && master_volume > 0;
        tile.toggleClass("is_active", is_active);
        if (!is_active) {
            tile.removeClass("active_fresh");
        }
        if (stream_players[name] && stream_players[name].video) {
            var player = stream_players[name];
            tile.attr("data-muted", unmuted ? "false" : "true");
            if (player.manual_paused) {
                player.video.muted = !unmuted;
                player.video.volume = unmuted ? master_volume : 0.0;
            } else {
                apply_video_audio(player.video, unmuted);
            }
        }
    });
}

function direct_player_element(name) {
    return $("<video>", {
        "class": "direct_player",
        autoplay: true,
        muted: true,
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
        var rendered_height = player.video.clientHeight;
        if (!rendered_height) {
            continue;
        }
        var target = pick_quality_for_height(player.qualities, Math.round(rendered_height * dpr));
        if (target === "best" || target === player.quality) {
            continue;
        }
        stream_quality_choice[name] = target;
        load_direct_stream(stream_tile_by_name(name), name, true, target);
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
    set_player_status(tile, "Loading stream...");
    $.ajax({
        url: "/api/direct-stream/" + encodeURIComponent(name),
        data: {quality: requested_quality, refresh: force_refresh ? "1" : "0"},
        timeout: 20000,
        success: function(data) {
            attach_hls_stream(tile, name, video, data.url);
            if (stream_players[name]) {
                // What the server actually served (may differ from requested),
                // plus the menu of available renditions, for the adapter.
                stream_players[name].quality = data.quality || requested_quality;
                stream_players[name].qualities = data.qualities || [];
            }
        },
        error: function(xhr) {
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

function attach_hls_stream(tile, name, video, url) {
    destroy_stream_player(name);
    stream_players[name] = {
        video: video,
        hls: null,
        manual_paused: false,
        stalled: false,
        recovering: false,
        last_time: video.currentTime || 0,
        last_progress_at: Date.now(),
        recovery_attempt: 0,
        recovery_timer: null,
        resume_timer: null
    };
    $(video).off(".playbackRecovery")
        .on("pause.playbackRecovery", function() {
            var player = stream_players[name];
            if (!player || player.video !== video) {
                return;
            }
            update_stream_playback_state(name);
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
                player.recovering = false;
                player.last_progress_at = Date.now();
                player.last_time = video.currentTime || 0;
                if (!player.resume_timer) {
                    player.stalled = false;
                    set_player_status(tile, "");
                }
            }
            update_stream_playback_state(name);
        })
        .on("timeupdate.playbackRecovery", function() {
            var player = stream_players[name];
            if (player && player.video === video && video.currentTime > player.last_time + 0.05) {
                player.last_time = video.currentTime;
                player.last_progress_at = Date.now();
                player.stalled = false;
                if (player.resume_timer) {
                    clearTimeout(player.resume_timer);
                    player.resume_timer = null;
                }
                set_player_status(tile, "");
                update_stream_playback_state(name);
            }
        })
        .on("ended.playbackRecovery error.playbackRecovery", function() {
            mark_stream_stalled(name, "Reconnecting stream...");
            reload_stream_playback(name);
        });
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
    } else if (window.Hls && Hls.isSupported()) {
        var hls = new Hls({
            liveSyncDurationCount: 3,
            lowLatencyMode: true
        });
        stream_players[name].hls = hls;
        hls.on(Hls.Events.ERROR, function(event, data) {
            if (data && data.fatal) {
                var player = stream_players[name];
                if (!player || player.hls !== hls) {
                    return;
                }
                mark_stream_stalled(name, "Reconnecting stream...");
                reload_stream_playback(name);
            }
        });
        hls.loadSource(url);
        hls.attachMedia(video);
    } else {
        set_player_status(tile, "This browser cannot play HLS streams.");
        return;
    }
    video.muted = true;
    video.volume = 0.0;
    safe_play(video);
    set_player_status(tile, "");
    sync_active_stream_audio();
}

function initialize_playback_recovery() {
    $(document).on("visibilitychange.playbackRecovery", function() {
        if (!document.hidden) {
            resume_all_after_inactive();
        }
    });
    $(window).on("focus.playbackRecovery pageshow.playbackRecovery", resume_all_after_inactive);
    setInterval(ensure_all_streams_playing, 5000);
}

// Chromium flips document.hidden to true when the window is fully occluded
// (covered or minimized) or the tab is backgrounded -- exactly when it pauses
// muted video. A visible window on a second monitor stays "active" even while
// unfocused, so we deliberately do NOT key off window focus here.
function page_active() {
    return !document.hidden;
}

// Coming back to the foreground: just nudge paused players back to play and
// reset stall tracking so the background gap isn't mistaken for a freeze. hls.js
// catches up to the live edge on its own -- no seeking or reloading, so a brief
// glance away doesn't trigger a buffer/reload.
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
        if (player.video.paused) {
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
    var no_progress = now - player.last_progress_at > 8000;
    if (player.video.paused) {
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
        mark_stream_stalled(name, "Reconnecting stream...");
        reload_stream_playback(name);
    }, 2500);
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

function toggle_stream_playback(name, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
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
            play_promise.catch(function() {});
        }
    } catch (e) {}
}

function apply_video_audio(video, unmuted) {
    if (!unmuted) {
        video.muted = true;
        video.volume = 0.0;
        safe_play(video);
        return;
    }
    video.volume = master_volume;
    if (video.paused) {
        video.muted = true;
        try {
            var play_promise = video.play();
            if (play_promise && play_promise.then) {
                play_promise.then(function() {
                    video.volume = master_volume;
                    video.muted = false;
                }).catch(function() {});
            } else {
                video.muted = false;
            }
        } catch (e) {}
    } else {
        video.muted = false;
        safe_play(video);
    }
}

function set_master_volume(value) {
    var pct = parseInt(value, 10);
    if (isNaN(pct)) {
        return;
    }
    pct = Math.max(0, Math.min(100, pct));
    audio_unlocked = true;
    master_volume = pct / 100;
    master_muted = pct == 0;
    update_volume_display();
    update_mute_button();
    persist_audio_settings();
    sync_active_stream_audio();
}

function toggle_master_mute() {
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
    var label = master_muted ? "Unmute" : "Mute";
    $("#mute_button")
        .text(master_muted ? "\uD83D\uDD07" : "\uD83D\uDD0A")
        .attr("aria-label", label)
        .attr("title", label);
}

function update_volume_display() {
    var pct = Math.round(master_volume * 100);
    $("#volume_slider").val(pct);
    // Show "Muted" rather than a percentage so the readout matches what's heard.
    $("#volume_value").text(master_muted ? "Muted" : pct + "%");
    $("#volume_slider").closest(".slider_row").toggleClass("is_muted", master_muted);
}

function destroy_stream_player(name) {
    var player = stream_players[name];
    if (!player) {
        return;
    }
    try {
        if (player.recovery_timer) {
            clearTimeout(player.recovery_timer);
        }
        if (player.resume_timer) {
            clearTimeout(player.resume_timer);
        }
        if (player.hls) {
            player.hls.destroy();
        }
    } catch (e) {}
    delete stream_players[name];
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
        scroll: false,
        tolerance: "pointer",
        start: function(event, ui) {
            stream_dragging = true;
            stream_drag_name = ui.item.attr("data-stream");
            stream_drag_order = streams.slice();
            stream_drag_pointer = pointer_from_event(event);
            stream_drag_target_name = null;
        },
        sort: function(event) {
            stream_drag_pointer = pointer_from_event(event);
            stream_drag_target_name = stream_name_under_pointer(stream_drag_pointer, stream_drag_name);
        },
        change: function(event) {
            stream_drag_pointer = pointer_from_event(event);
            stream_drag_target_name = stream_name_under_pointer(stream_drag_pointer, stream_drag_name);
        },
        stop: function(event) {
            stream_drag_pointer = pointer_from_event(event) || stream_drag_pointer;
            apply_stream_drop_replacement();
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
    $("#streams .stream").each(function() {
        var tile = $(this);
        var name = tile.attr("data-stream");
        if (!name || name == exclude_name || tile.hasClass("ui-sortable-helper")) {
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
    streams = $("#streams .stream").map(function() {
        return $(this).attr("data-stream");
    }).get();
    // Keep the chosen audio stream; only fall back if it's no longer present.
    if (streams.indexOf(active_stream) == -1) {
        active_stream = streams.length ? streams[0] : null;
    }
    reorder_chat_for_streams();
    update_url();
    sync_active_stream_audio();
    optimize_size(streams.length);
    update_all_stream_tile_metadata();
}

function reorder_chat_for_streams() {
    var tablist = $("#tablist");
    var chatbox = $("#chatbox");
    for (var i = 0; i < streams.length; i++) {
        var stream = streams[i];
        tablist.append(tablist.find("a[href='#chat-" + stream + "']").parent());
        chatbox.append($("#chat-" + stream));
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
    load_current_stream_metadata();
    auto_check_stream_together([name]);
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
        list.append(
            $("<div>", {"class": "current_stream"})
                .toggleClass("is_active", name == active_stream)
                .append($("<span>", {"class": "current_stream_name"}).text(name).click((function(stream_name) {
                    return function() {
                        set_active_stream(stream_name);
                    };
                })(name)))
                .append($("<button>", {
                    type: "button",
                    "class": "remove_stream",
                    "aria-label": "Remove " + name,
                    title: "Remove",
                    text: "×"
                }).click((function(stream_name) {
                    return function() {
                        remove_stream(stream_name);
                    };
                })(name)))
        );
    }
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
    $("#theater_chat_button").toggleClass("is_selected", chat_on && !chat_hidden).attr("aria-pressed", (chat_on && !chat_hidden) ? "true" : "false");
    optimize_size(-1);
}

function show_theater_hint() {
    var hint = $("#theater_hint");
    hint.addClass("is_visible");
    clearTimeout(hint.data("hide_timer"));
    hint.data("hide_timer", setTimeout(function() {
        hint.removeClass("is_visible");
    }, 3200));
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
                return;
            }

            $("#twitch_connect_button").prop("disabled", false);
            if (!data.connected) {
                twitch_user = null;
                set_twitch_state("Offline", "offline");
                $("#twitch_disconnect_button").hide();
                set_twitch_hint(data.message || "Connect Twitch to load followed channels.");
                return;
            }

            twitch_user = data;
            set_twitch_state(data.login, "connected");
            $("#twitch_disconnect_button").show();
            set_twitch_hint("Connected as " + data.login + ".");
            load_current_stream_metadata();
            load_followed_channels();
        },
        error: function() {
            set_twitch_state("Error", "error");
            set_twitch_hint("Could not check Twitch session.");
        }
    });
}

function connect_twitch() {
    ensure_twitch_auth_listener();
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
        method: "POST",
        complete: function() {
            twitch_user = null;
            followed_channels = [];
            twitch_live_channels = {};
            $("#followed_channels").empty();
            $("#twitch_disconnect_button").hide();
            set_twitch_state("Offline", "offline");
            set_twitch_hint("Signed out.");
        }
    });
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
            load_followed_live_streams();
        }
    });
}

function load_followed_live_streams() {
    twitch_api("followed-streams", {first: 100}, function(data) {
        var live = data.data || [];
        for (var i = 0; i < live.length; i++) {
            twitch_live_channels[live[i].user_login] = live[i];
            stream_metadata[live[i].user_login.toLowerCase()] = live[i];
        }
        render_followed_channels();
        update_all_stream_tile_metadata();
        set_twitch_hint("Loaded " + followed_channels.length + " followed channels.");
    });
}

function render_followed_channels() {
    var container = $("#followed_channels");
    if (container.length == 0) {
        return;
    }
    var filter = $.trim($("#follow_filter").val() || "").toLowerCase();
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
        container.append(item);
        if (shown >= 80) {
            break;
        }
    }
    if (!shown) {
        container.append($("<div>", {"class": "empty_state"}).text("No matches."));
    }
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
}

// Render the version from the (hot-served) JS so a hard refresh shows it even if
// the dev server cached an older template.
$(render_app_version);
