"""Best-effort country lookup from a client IP.

Reads an offline MaxMind-format database (we ship DB-IP's IP-to-Country Lite,
CC-BY-4.0) and returns only a 2-letter ISO country code. The IP itself is never
stored or logged -- it is passed in, looked up, and discarded by the caller.

Everything degrades gracefully to '' (unknown country): missing library, missing
or unreadable DB file, unknown/invalid IP. The reader is loaded once and cached.
"""

import os
import threading

try:
    import maxminddb
except Exception:  # pragma: no cover - library is optional at runtime
    maxminddb = None

DEFAULT_DB_PATH = '/app/geoip/country.mmdb'

_LOCK = threading.Lock()
_reader = None
_loaded_path = None


def _db_path():
    return os.environ.get('GEOIP_COUNTRY_DB', '').strip() or DEFAULT_DB_PATH


def _get_reader():
    global _reader, _loaded_path
    path = _db_path()
    with _LOCK:
        if _loaded_path == path:
            return _reader
        _loaded_path = path
        if maxminddb is None or not path or not os.path.isfile(path):
            _reader = None
            return None
        try:
            _reader = maxminddb.open_database(path)
        except Exception:
            _reader = None
        return _reader


def country_code(ip):
    """Return the uppercase 2-letter ISO country for `ip`, or '' if unknown."""
    if not ip:
        return ''
    reader = _get_reader()
    if reader is None:
        return ''
    try:
        record = reader.get(ip)
    except Exception:
        return ''
    if not isinstance(record, dict):
        return ''
    code = (record.get('country') or {}).get('iso_code') or ''
    return code.upper()[:2] if code else ''


def reset():
    """Drop the cached reader -- used by tests to swap the configured DB path."""
    global _reader, _loaded_path
    with _LOCK:
        _reader = None
        _loaded_path = None
