import json
import os
import unittest
from types import SimpleNamespace
from unittest import mock

from multitwitch.views import analytics
from multitwitch.lib import geoip


class FakeReader:
    def __init__(self, mapping):
        self.mapping = mapping

    def get(self, ip):
        if ip == 'bad-ip':
            raise ValueError('invalid ip')
        return self.mapping.get(ip)


def request(headers=None, remote_addr='10.0.0.1', host='streammulti.live'):
    return SimpleNamespace(
        headers=headers or {},
        remote_addr=remote_addr,
        host=host,
    )


class GeoipTests(unittest.TestCase):
    def tearDown(self):
        geoip.reset()

    def test_empty_ip_returns_blank(self):
        self.assertEqual(geoip.country_code(''), '')

    def test_missing_db_returns_blank(self):
        geoip.reset()
        with mock.patch.dict(os.environ, {'GEOIP_COUNTRY_DB': '/no/such/country.mmdb'}):
            self.assertEqual(geoip.country_code('1.2.3.4'), '')

    def test_lookup_uppercases_iso_code(self):
        geoip._loaded_path = geoip._db_path()
        geoip._reader = FakeReader({'1.2.3.4': {'country': {'iso_code': 'au'}}})
        self.assertEqual(geoip.country_code('1.2.3.4'), 'AU')

    def test_unknown_ip_and_reader_errors_are_blank(self):
        geoip._loaded_path = geoip._db_path()
        geoip._reader = FakeReader({'1.2.3.4': {'country': {'iso_code': 'au'}}})
        self.assertEqual(geoip.country_code('9.9.9.9'), '')     # not in DB
        self.assertEqual(geoip.country_code('bad-ip'), '')      # reader raises


class BrowserOsTests(unittest.TestCase):
    def test_browser_family(self):
        cases = {
            'Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/120.0 Safari/537.36': 'Chrome',
            'Mozilla/5.0 (X11; Linux) Gecko Firefox/121.0': 'Firefox',
            'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120.0': 'Edge',
            'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 OPR/106.0': 'Opera',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/604.1': 'Safari',
            'curl/8.4.0': 'Other',
            '': '',
        }
        for ua, expected in cases.items():
            self.assertEqual(analytics._browser_family(ua), expected, ua)

    def test_os_family(self):
        cases = {
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64)': 'Windows',
            'Mozilla/5.0 (Linux; Android 13; Pixel 7)': 'Android',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)': 'iOS',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)': 'macOS',
            'Mozilla/5.0 (X11; Linux x86_64)': 'Linux',
            'SomethingElse/1.0': 'Other',
            '': '',
        }
        for ua, expected in cases.items():
            self.assertEqual(analytics._os_family(ua), expected, ua)


class AcceptLanguageTests(unittest.TestCase):
    def test_valid_and_invalid(self):
        cases = {
            'en-AU,en;q=0.9': 'en-au',
            'en': 'en',
            'de-DE': 'de-de',
            'pt-BR,pt;q=0.8,en;q=0.6': 'pt-br',
            '*': '',
            '': '',
            'not a language': '',
        }
        for header, expected in cases.items():
            self.assertEqual(analytics._accept_language(request({'Accept-Language': header})), expected, header)


class VisitorHashTests(unittest.TestCase):
    def test_no_salt_returns_blank(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ANALYTICS_VISITOR_SALT', None)
            self.assertEqual(analytics._visitor_hash(request()), '')

    def test_no_session_returns_blank(self):
        with mock.patch.dict(os.environ, {'ANALYTICS_VISITOR_SALT': 'pepper'}):
            with mock.patch('multitwitch.views.twitch._session_from_request', return_value=None):
                self.assertEqual(analytics._visitor_hash(request()), '')

    def test_hashes_user_id_stably_and_pseudonymously(self):
        with mock.patch.dict(os.environ, {'ANALYTICS_VISITOR_SALT': 'pepper'}):
            session = {'user': {'user_id': '12345', 'login': 'somebody'}}
            with mock.patch('multitwitch.views.twitch._session_from_request', return_value=session):
                first = analytics._visitor_hash(request())
                second = analytics._visitor_hash(request())
        self.assertEqual(first, second)                       # stable
        self.assertEqual(len(first), analytics.VISITOR_HASH_LENGTH)
        self.assertNotIn('12345', first)                      # not the raw id
        self.assertNotIn('somebody', first)                   # never the username

    def test_salt_change_changes_hash(self):
        session = {'user': {'user_id': '12345'}}
        with mock.patch('multitwitch.views.twitch._session_from_request', return_value=session):
            with mock.patch.dict(os.environ, {'ANALYTICS_VISITOR_SALT': 'saltA'}):
                a = analytics._visitor_hash(request())
            with mock.patch.dict(os.environ, {'ANALYTICS_VISITOR_SALT': 'saltB'}):
                b = analytics._visitor_hash(request())
        self.assertNotEqual(a, b)


class ServerFieldsTests(unittest.TestCase):
    def test_enrichment_is_server_authoritative_and_ip_free(self):
        req = request(headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36',
            'Accept-Language': 'en-AU,en;q=0.9',
            'X-Forwarded-For': '1.2.3.4',
        })
        with mock.patch.object(analytics.geoip, 'country_code', return_value='AU'):
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop('ANALYTICS_VISITOR_SALT', None)
                # A client trying to inject its own country must be overridden.
                out = analytics._with_server_fields(req, {'event': 'page_view', 'country': 'ZZ'})

        self.assertEqual(out['country'], 'AU')
        self.assertEqual(out['browser'], 'Chrome')
        self.assertEqual(out['os'], 'Windows')
        self.assertEqual(out['language'], 'en-au')
        self.assertEqual(out['host'], 'streammulti.live')
        self.assertIn('ts', out)
        self.assertNotIn('visitor', out)                       # no salt configured
        self.assertNotIn('1.2.3.4', json.dumps(out))           # raw IP never stored

    def test_timezone_is_allowlisted_and_others_dropped(self):
        event = analytics._sanitize_event({
            'event': 'page_view',
            'timezone': 'Australia/Brisbane',
            'bogus_field': 'x',
        })
        self.assertEqual(event['timezone'], 'Australia/Brisbane')
        self.assertNotIn('bogus_field', event)


if __name__ == '__main__':
    unittest.main()
