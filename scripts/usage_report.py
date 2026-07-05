#!/usr/bin/env python3
"""Summarize StreamMulti usage-event logs (text/JSON report).

The app appends usage events as JSON lines to a daily-rotated log file
(see multitwitch/views/analytics.py). This script reads one or more of those
`.jsonl` files and prints a human-readable summary: daily visits, session
sizes, UI-state mix, device buckets, and client-error rates.

Aggregation lives in multitwitch/lib/usage_report.py and is shared with the
web dashboard; this file is just the CLI + text rendering.

Usage:
    # Point at the file *stem* configured in ANALYTICS_LOG_FILE and it will
    # expand to every dated sibling (usage-events-YYYY-MM-DD.jsonl):
    python scripts/usage_report.py /app/data/usage-events.jsonl

    # Or pass explicit files / globs / a directory:
    python scripts/usage_report.py data/usage-events-2026-07-*.jsonl
    python scripts/usage_report.py /app/data/

    # Restrict to a date range (inclusive, UTC) and/or emit JSON:
    python scripts/usage_report.py /app/data/usage-events.jsonl \
        --since 2026-06-01 --until 2026-06-30 --json

Reads from stdin when no paths are given (pipe raw JSONL in).
"""

import argparse
import json
import os
import sys

# Allow `python scripts/usage_report.py` from a checkout without installing.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from multitwitch.lib.usage_report import (  # noqa: E402
    SCREEN_ORDER,
    VIEWPORT_ORDER,
    expand_paths,
    iter_events,
    summarize,
    to_jsonable,
)


def pct(part, whole):
    return (100.0 * part / whole) if whole else 0.0


def bar(part, whole, width=24):
    filled = int(round(width * (part / whole))) if whole else 0
    return '#' * filled + '.' * (width - filled)


def print_dist(title, counter, order=None):
    total = sum(counter.values())
    print('  %s' % title)
    if not total:
        print('    (no data)')
        print('')
        return
    items = ([(k, counter.get(k, 0)) for k in order if counter.get(k)]
             if order else counter.most_common())
    for key, count in items:
        print('    %-10s %6d  %5.1f%%  %s' % (str(key), count, pct(count, total), bar(count, total)))
    print('')


def print_report(s):
    totals = s['totals']
    total_events = sum(totals.values())
    days = s['days']
    page_views = totals.get('page_view', 0)
    errors = totals.get('client_error', 0)

    print('=' * 60)
    print('StreamMulti usage report')
    print('=' * 60)
    if days:
        print('Date range   : %s -> %s  (%d day%s with data)'
              % (days[0], days[-1], len(days), '' if len(days) == 1 else 's'))
    print('Total events : %d' % total_events)
    print('Page views   : %d  (avg %.1f/day)' % (page_views, page_views / len(days) if days else 0.0))
    print('Client errors: %d  (%.1f per 100 views)' % (errors, pct(errors, page_views)))
    print('')

    print('Events by type')
    for name, count in totals.most_common():
        print('    %-26s %6d  %5.1f%%' % (name, count, pct(count, total_events)))
    print('')

    if days:
        print('Daily activity')
        print('    %-12s %8s %8s %8s' % ('date', 'views', 'added', 'errors'))
        for day in days:
            d = s['per_day'][day]
            print('    %-12s %8d %8d %8d'
                  % (day, d.get('page_view', 0), d.get('stream_added', 0), d.get('client_error', 0)))
        print('')

    print('Session shape (at page load)')
    print_dist('Streams open', s['stream_counts'], order=list(range(0, 100)))
    print_dist('Viewport width', s['viewports'], order=VIEWPORT_ORDER)
    print_dist('Screen size', s['screens'], order=SCREEN_ORDER)
    print_dist('Layout mode', s['layouts'])

    print('UI preferences (share of page loads)')
    pv = page_views or 1
    print('    dark mode on   : %5.1f%%' % pct(s['darkmode'].get(True, 0), pv))
    print('    theater mode on: %5.1f%%' % pct(s['theater'].get(True, 0), pv))
    print('    chat hidden    : %5.1f%%' % pct(s['chat_hidden'].get(True, 0), pv))
    print('')

    if errors:
        print('Client errors')
        print_dist('By kind', s['error_kinds'])
        print_dist('By area', s['error_areas'])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('paths', nargs='*',
                        help='JSONL files, globs, a directory, or the log-file stem. '
                             'Reads stdin if omitted.')
    parser.add_argument('--since', help='Earliest UTC date to include (YYYY-MM-DD).')
    parser.add_argument('--until', help='Latest UTC date to include (YYYY-MM-DD).')
    parser.add_argument('--json', action='store_true', help='Emit JSON instead of a text report.')
    args = parser.parse_args(argv)

    files = expand_paths(args.paths) if args.paths else []
    if args.paths and not files:
        print('No matching log files found for: %s' % ' '.join(args.paths), file=sys.stderr)
        return 1

    if files and not args.json:
        print('Reading %d file%s:' % (len(files), '' if len(files) == 1 else 's'), file=sys.stderr)
        for f in files:
            print('  %s' % f, file=sys.stderr)

    summary = summarize(iter_events(files, since=args.since, until=args.until, use_stdin=not files))

    if sum(summary['totals'].values()) == 0:
        print('No events found in the selected range.', file=sys.stderr)
        return 1

    if args.json:
        json.dump(to_jsonable(summary), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write('\n')
    else:
        print_report(summary)
    return 0


if __name__ == '__main__':
    sys.exit(main())
