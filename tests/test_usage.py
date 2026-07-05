import json
import os
import tempfile
import time
import unittest
from http.cookies import SimpleCookie
from types import SimpleNamespace

from multitwitch.lib import usage_report
from multitwitch.lib.passwords import hash_password, verify_password
from multitwitch.views import usage

# A precomputed low-iteration hash keeps the test suite fast; production uses the
# library default (600k). The plaintext is "hunter2".
TEST_PASSWORD = 'hunter2'
TEST_HASH = hash_password(TEST_PASSWORD, iterations=1000)


def make_request(method='GET', params=None, headers=None, settings=None, scheme='https'):
    return SimpleNamespace(
        method=method,
        params=params or {},
        headers=headers or {},
        scheme=scheme,
        remote_addr='127.0.0.1',
        registry=SimpleNamespace(settings=settings if settings is not None else {}),
    )


def enabled_settings(log_file=''):
    return {
        'analytics.dashboard_password_hash': TEST_HASH,
        'analytics.log_file': log_file,
    }


def cookie_from_response(response):
    header = response.headers.get('Set-Cookie')
    if not header:
        return None
    jar = SimpleCookie()
    jar.load(header)
    if usage.COOKIE_NAME not in jar:
        return None
    return jar[usage.COOKIE_NAME].value


def cookie_header(value):
    return {'Cookie': '%s=%s' % (usage.COOKIE_NAME, value)}


# --- Password hashing ------------------------------------------------------

class PasswordHashTests(unittest.TestCase):
    def test_round_trip(self):
        encoded = hash_password('correct horse', iterations=1000)
        self.assertTrue(verify_password('correct horse', encoded))

    def test_wrong_password_rejected(self):
        self.assertFalse(verify_password('nope', TEST_HASH))

    def test_malformed_hash_rejected(self):
        self.assertFalse(verify_password('x', 'not-a-hash'))
        self.assertFalse(verify_password('x', ''))
        self.assertFalse(verify_password('x', 'bcrypt$1$aa$bb'))

    def test_salt_makes_hashes_unique(self):
        self.assertNotEqual(
            hash_password('same', iterations=1000),
            hash_password('same', iterations=1000),
        )


# --- Log aggregation -------------------------------------------------------

class UsageReportTests(unittest.TestCase):
    def _events(self, day, count, name='page_view', **extra):
        rows = []
        for i in range(count):
            row = {'event': name, 'ts': '%sT12:%02d:00Z' % (day, i % 60)}
            row.update(extra)
            rows.append(row)
        return rows

    def _write(self, directory, day, events):
        path = os.path.join(directory, 'usage-events-%s.jsonl' % day)
        with open(path, 'w', encoding='utf-8') as f:
            for e in events:
                f.write(json.dumps(e) + '\n')
        return path

    def test_summarize_counts_and_distributions(self):
        events = (
            self._events('2026-07-04', 3, stream_count=2, viewport='lg', darkmode=True)
            + self._events('2026-07-04', 1, name='client_error', area='runtime', kind='TypeError')
        )
        summary = usage_report.summarize((e, usage_report.event_day(e)) for e in events)
        self.assertEqual(summary['totals']['page_view'], 3)
        self.assertEqual(summary['totals']['client_error'], 1)
        self.assertEqual(summary['stream_counts'][2], 3)
        self.assertEqual(summary['viewports']['lg'], 3)
        self.assertEqual(summary['darkmode'][True], 3)
        self.assertEqual(summary['error_kinds']['TypeError'], 1)
        self.assertEqual(summary['days'], ['2026-07-04'])

    def test_expand_stem_and_date_filter(self):
        with tempfile.TemporaryDirectory() as d:
            self._write(d, '2026-07-04', self._events('2026-07-04', 2))
            self._write(d, '2026-07-05', self._events('2026-07-05', 5))
            stem = os.path.join(d, 'usage-events.jsonl')

            files = usage_report.expand_paths([stem])
            self.assertEqual(len(files), 2)

            all_days = usage_report.summarize(usage_report.iter_events(files))
            self.assertEqual(all_days['totals']['page_view'], 7)

            filtered = usage_report.summarize(
                usage_report.iter_events(files, since='2026-07-05', until='2026-07-05')
            )
            self.assertEqual(filtered['days'], ['2026-07-05'])
            self.assertEqual(filtered['totals']['page_view'], 5)

    def test_enrichment_and_repeat_visitor_aggregation(self):
        events = [
            {'event': 'page_view', 'ts': '2026-07-04T10:00:00Z', 'country': 'AU',
             'browser': 'Chrome', 'os': 'Windows', 'language': 'en-au',
             'timezone': 'Australia/Brisbane', 'visitor': 'aaaa'},
            {'event': 'page_view', 'ts': '2026-07-05T10:00:00Z', 'country': 'AU',
             'browser': 'Firefox', 'os': 'Linux', 'language': 'en-au', 'visitor': 'aaaa'},
            {'event': 'page_view', 'ts': '2026-07-05T11:00:00Z', 'country': 'US',
             'browser': 'Chrome', 'os': 'macOS', 'visitor': 'bbbb'},
        ]
        summary = usage_report.summarize((e, usage_report.event_day(e)) for e in events)
        self.assertEqual(summary['countries']['AU'], 2)
        self.assertEqual(summary['countries']['US'], 1)
        self.assertEqual(summary['browsers']['Chrome'], 2)
        self.assertEqual(summary['oses']['Windows'], 1)
        self.assertEqual(summary['languages']['en-au'], 2)
        self.assertEqual(summary['timezones']['Australia/Brisbane'], 1)
        # 'aaaa' seen on two distinct days -> returning; 'bbbb' on one day only.
        self.assertEqual(summary['unique_visitors'], 2)
        self.assertEqual(summary['repeat_visitors'], 1)

    def test_malformed_lines_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'usage-events-2026-07-04.jsonl')
            with open(path, 'w', encoding='utf-8') as f:
                f.write('{"event":"page_view","ts":"2026-07-04T00:00:00Z"}\n')
                f.write('not json\n')
                f.write('[1,2,3]\n')  # valid json, wrong type
                f.write('\n')
            summary = usage_report.summarize(usage_report.iter_events([path]))
            self.assertEqual(summary['totals']['page_view'], 1)


# --- Dashboard views / auth ------------------------------------------------

class UsageAuthTests(unittest.TestCase):
    def setUp(self):
        usage._LOGIN_ATTEMPTS.clear()

    def test_disabled_when_no_hash_configured(self):
        req = make_request(settings={})
        self.assertEqual(usage.dashboard(req).status_int, 404)
        self.assertEqual(usage.login(req).status_int, 404)
        self.assertEqual(usage.data(req).status_int, 404)

    def test_dashboard_redirects_to_login_when_unauthenticated(self):
        req = make_request(settings=enabled_settings())
        response = usage.dashboard(req)
        self.assertEqual(response.status_int, 302)
        self.assertEqual(response.location, '/admin/login')

    def test_login_get_renders_form(self):
        response = usage.login(make_request(settings=enabled_settings()))
        self.assertEqual(response.status_int, 200)
        self.assertIn('name="password"', response.text)

    def test_login_wrong_password_sets_no_cookie(self):
        req = make_request('POST', params={'password': 'wrong'}, settings=enabled_settings())
        response = usage.login(req)
        self.assertEqual(response.status_int, 401)
        self.assertIsNone(cookie_from_response(response))

    def test_login_success_sets_cookie_and_redirects(self):
        req = make_request('POST', params={'password': TEST_PASSWORD}, settings=enabled_settings())
        response = usage.login(req)
        self.assertEqual(response.status_int, 303)
        self.assertEqual(response.location, '/admin/usage')
        self.assertIsNotNone(cookie_from_response(response))
        set_cookie = response.headers.get('Set-Cookie')
        self.assertIn('HttpOnly', set_cookie)
        self.assertIn('secure', set_cookie.lower())
        self.assertIn('SameSite=Lax', set_cookie)

    def test_valid_cookie_grants_dashboard_and_data(self):
        login_req = make_request('POST', params={'password': TEST_PASSWORD}, settings=enabled_settings())
        cookie = cookie_from_response(usage.login(login_req))

        req = make_request(headers=cookie_header(cookie), settings=enabled_settings())
        self.assertEqual(usage.dashboard(req).status_int, 200)
        self.assertEqual(usage.data(req).status_int, 200)

    def test_data_requires_authentication(self):
        req = make_request(settings=enabled_settings())
        self.assertEqual(usage.data(req).status_int, 401)

    def test_expired_cookie_rejected(self):
        req = make_request(settings=enabled_settings())
        expiry = int(time.time()) - 10
        value = '%d.%s' % (expiry, usage._sign(req, expiry))
        req.headers = cookie_header(value)
        self.assertFalse(usage._authenticated(req))

    def test_tampered_cookie_rejected(self):
        login_req = make_request('POST', params={'password': TEST_PASSWORD}, settings=enabled_settings())
        cookie = cookie_from_response(usage.login(login_req))
        expiry, _, _sig = cookie.partition('.')
        forged = '%s.%s' % (expiry, 'deadbeef' * 8)
        req = make_request(headers=cookie_header(forged), settings=enabled_settings())
        self.assertFalse(usage._authenticated(req))

    def test_cookie_invalid_after_password_change(self):
        login_req = make_request('POST', params={'password': TEST_PASSWORD}, settings=enabled_settings())
        cookie = cookie_from_response(usage.login(login_req))

        other = {'analytics.dashboard_password_hash': hash_password('different', iterations=1000)}
        req = make_request(headers=cookie_header(cookie), settings=other)
        self.assertFalse(usage._authenticated(req))

    def test_logout_clears_cookie(self):
        response = usage.logout(make_request('POST', settings=enabled_settings()))
        self.assertEqual(response.status_int, 303)
        self.assertEqual(response.location, '/admin/login')
        set_cookie = response.headers.get('Set-Cookie')
        self.assertIn(usage.COOKIE_NAME, set_cookie)
        self.assertIn('Max-Age=0', set_cookie)

    def test_login_rate_limited(self):
        settings = enabled_settings()
        headers = {'X-Forwarded-For': '203.0.113.9'}
        statuses = []
        for _ in range(usage.LOGIN_MAX_ATTEMPTS + 2):
            req = make_request('POST', params={'password': 'wrong'}, headers=headers, settings=settings)
            statuses.append(usage.login(req).status_int)
        self.assertEqual(statuses.count(429), 2)
        self.assertEqual(statuses[usage.LOGIN_MAX_ATTEMPTS], 429)

    def test_data_returns_summary_json_with_date_filter(self):
        with tempfile.TemporaryDirectory() as d:
            for day, n in (('2026-07-04', 2), ('2026-07-05', 4)):
                path = os.path.join(d, 'usage-events-%s.jsonl' % day)
                with open(path, 'w', encoding='utf-8') as f:
                    for i in range(n):
                        f.write(json.dumps({'event': 'page_view', 'ts': '%sT01:00:0%d Z' % (day, i)}) + '\n')
            settings = enabled_settings(log_file=os.path.join(d, 'usage-events.jsonl'))

            login_req = make_request('POST', params={'password': TEST_PASSWORD}, settings=settings)
            cookie = cookie_from_response(usage.login(login_req))
            req = make_request(
                params={'since': '2026-07-05', 'until': '2026-07-05'},
                headers=cookie_header(cookie),
                settings=settings,
            )
            response = usage.data(req)
            self.assertEqual(response.status_int, 200)
            self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
            body = json.loads(response.text)
            self.assertTrue(body['configured'])
            self.assertEqual(body['file_count'], 2)
            self.assertEqual(body['days'], ['2026-07-05'])
            self.assertEqual(body['totals']['page_view'], 4)


class CleanDateTests(unittest.TestCase):
    def test_accepts_well_formed_dates(self):
        self.assertEqual(usage._clean_date('2026-07-05'), '2026-07-05')

    def test_rejects_malformed_input(self):
        for bad in ('', '2026/07/05', 'garbage', '2026-7-5', 'abcd-ef-gh'):
            self.assertIsNone(usage._clean_date(bad))

    def test_injection_attempt_is_truncated_to_a_safe_date(self):
        # Over-length input is capped at 10 chars and re-validated, so a valid
        # date prefix survives as a plain date and the rest cannot leak through.
        self.assertEqual(usage._clean_date("2026-07-05'; DROP TABLE"), '2026-07-05')


if __name__ == '__main__':
    unittest.main()
