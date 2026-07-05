"""Shared parsing/aggregation for StreamMulti usage-event logs.

The app appends usage events as JSON lines to a daily-rotated log file (see
multitwitch/views/analytics.py). This module turns those `.jsonl` files into a
summary structure. It is consumed by both the CLI report
(scripts/usage_report.py) and the web dashboard (multitwitch/views/usage.py),
so the aggregation logic lives in exactly one place.

Pure stdlib, no framework imports, so the CLI stays dependency-free.
"""

import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict

DATED_RE = re.compile(r'^(?P<stem>.+)-(?P<date>\d{4}-\d{2}-\d{2})(?P<ext>\.[^.]+)$')

# Ordered buckets so distributions render in a natural order rather than by count.
VIEWPORT_ORDER = ['xs', 'sm', 'md', 'lg', 'xl']
SCREEN_ORDER = ['small', 'medium', 'large']


def expand_paths(paths):
    """Turn user-supplied paths into a concrete, de-duplicated file list.

    Accepts explicit files, glob patterns, directories (all *.jsonl inside),
    and a bare log-file stem such as `usage-events.jsonl`, which is expanded to
    its dated siblings `usage-events-YYYY-MM-DD.jsonl` the app actually writes.
    """
    found = []
    seen = set()

    def add(path):
        real = os.path.abspath(path)
        if real not in seen and os.path.isfile(path):
            seen.add(real)
            found.append(path)

    for path in paths:
        matches = glob.glob(path)
        if os.path.isdir(path):
            for f in sorted(glob.glob(os.path.join(path, '*.jsonl'))):
                add(f)
            continue
        if matches:
            for f in sorted(matches):
                if os.path.isdir(f):
                    for inner in sorted(glob.glob(os.path.join(f, '*.jsonl'))):
                        add(inner)
                else:
                    add(f)
            continue
        # No direct match: treat as a log-file stem and look for dated siblings.
        directory = os.path.dirname(path) or '.'
        filename = os.path.basename(path)
        stem, ext = os.path.splitext(filename)
        pattern = os.path.join(directory, '%s-*%s' % (stem, ext))
        for f in sorted(glob.glob(pattern)):
            add(f)

    return found


def date_of(path):
    m = DATED_RE.match(os.path.basename(path))
    return m.group('date') if m else None


def event_day(event):
    ts = event.get('ts')
    if isinstance(ts, str) and len(ts) >= 10:
        return ts[:10]
    return None


def in_range(day, since, until):
    if day is None:
        # Undated events survive filtering; they'd otherwise vanish silently.
        return since is None and until is None
    if since and day < since:
        return False
    if until and day > until:
        return False
    return True


def _iter_lines(lines, file_date, since, until):
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        day = event_day(event) or file_date
        if not in_range(day, since, until):
            continue
        yield event, day


def iter_events(files, since=None, until=None, use_stdin=False):
    """Yield (event_dict, day) for every valid JSON line in `files`.

    Reads stdin only when `use_stdin` is set and there are no files -- callers
    that aren't the CLI (e.g. the web view) must never accidentally block on
    stdin just because their log path is unconfigured.
    """
    if files:
        for path in files:
            file_date = date_of(path)
            with open(path, 'r', encoding='utf-8') as f:
                for pair in _iter_lines(f, file_date, since, until):
                    yield pair
    elif use_stdin:
        for pair in _iter_lines(sys.stdin, None, since, until):
            yield pair


def summarize(events):
    """Aggregate an (event, day) iterable into a summary dict of Counters."""
    totals = Counter()
    per_day = defaultdict(Counter)
    stream_counts = Counter()
    viewports = Counter()
    screens = Counter()
    layouts = Counter()
    darkmode = Counter()
    theater = Counter()
    chat_hidden = Counter()
    error_kinds = Counter()
    error_areas = Counter()
    countries = Counter()
    browsers = Counter()
    oses = Counter()
    languages = Counter()
    timezones = Counter()
    # Repeat-visitor tracking: which distinct days each pseudonymous visitor was
    # seen on. A visitor seen on >= 2 days is "returning".
    visitor_days = defaultdict(set)
    days = set()

    for event, day in events:
        name = event.get('event', 'unknown')
        totals[name] += 1
        if day:
            days.add(day)
            per_day[day][name] += 1

        visitor = event.get('visitor')
        if visitor and day:
            visitor_days[visitor].add(day)

        if name == 'page_view':
            sc = event.get('stream_count')
            if isinstance(sc, int):
                stream_counts[sc] += 1
            for value, counter in (
                (event.get('viewport'), viewports),
                (event.get('screen'), screens),
                (event.get('layout'), layouts),
                (event.get('country'), countries),
                (event.get('browser'), browsers),
                (event.get('os'), oses),
                (event.get('language'), languages),
                (event.get('timezone'), timezones),
            ):
                if value:
                    counter[value] += 1
            darkmode[bool(event.get('darkmode'))] += 1
            theater[bool(event.get('theater'))] += 1
            chat_hidden[bool(event.get('chat_hidden'))] += 1

        if name == 'client_error':
            error_kinds[event.get('kind') or 'unknown'] += 1
            error_areas[event.get('area') or 'unknown'] += 1

    return {
        'totals': totals,
        'per_day': per_day,
        'stream_counts': stream_counts,
        'viewports': viewports,
        'screens': screens,
        'layouts': layouts,
        'darkmode': darkmode,
        'theater': theater,
        'chat_hidden': chat_hidden,
        'error_kinds': error_kinds,
        'error_areas': error_areas,
        'countries': countries,
        'browsers': browsers,
        'oses': oses,
        'languages': languages,
        'timezones': timezones,
        'unique_visitors': len(visitor_days),
        'repeat_visitors': sum(1 for seen in visitor_days.values() if len(seen) >= 2),
        'days': sorted(days),
    }


def to_jsonable(s):
    """Convert a summary dict into plain JSON-serializable structures."""
    return {
        'days': s['days'],
        'totals': dict(s['totals']),
        'per_day': {day: dict(counter) for day, counter in s['per_day'].items()},
        'stream_counts': {str(k): v for k, v in s['stream_counts'].items()},
        'viewports': dict(s['viewports']),
        'screens': dict(s['screens']),
        'layouts': dict(s['layouts']),
        'darkmode': {str(k): v for k, v in s['darkmode'].items()},
        'theater': {str(k): v for k, v in s['theater'].items()},
        'chat_hidden': {str(k): v for k, v in s['chat_hidden'].items()},
        'error_kinds': dict(s['error_kinds']),
        'error_areas': dict(s['error_areas']),
        'countries': dict(s['countries']),
        'browsers': dict(s['browsers']),
        'oses': dict(s['oses']),
        'languages': dict(s['languages']),
        'timezones': dict(s['timezones']),
        'unique_visitors': s['unique_visitors'],
        'repeat_visitors': s['repeat_visitors'],
    }
