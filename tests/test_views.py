import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from multitwitch.views import direct, twitch
from multitwitch.views.web import WebView


def response_json(response):
    return json.loads(response.text)


class WebViewTests(unittest.TestCase):
    def test_home_normalizes_deduplicates_and_rejects_invalid_channels(self):
        request = SimpleNamespace(
            matchdict={'streams': ['GamesDoneQuick', 'gamesdonequick', 'bad-name', 'Other_Channel']},
            params={},
            domain='localhost',
            host='localhost:6543',
        )

        response = WebView.home(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text.count('data-stream="gamesdonequick"'), 1)
        self.assertEqual(response.text.count('data-stream="other_channel"'), 1)
        self.assertNotIn('bad-name', response.text)
        self.assertIn('var twitch_parent_query = "parent=localhost";', response.text)
        self.assertIn('class="panel_section is_collapsed" id="stream_together_panel"', response.text)
        self.assertIn('<div id="stream_together_body" hidden>', response.text)

    def test_healthz(self):
        response = WebView.healthz(SimpleNamespace())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, 'ok')


class DirectStreamTests(unittest.TestCase):
    def setUp(self):
        direct.STREAM_CACHE.clear()

    def tearDown(self):
        direct.STREAM_CACHE.clear()

    def request(self, channel, **params):
        values = {'quality': 'best'}
        values.update(params)
        return SimpleNamespace(matchdict={'channel': channel}, params=values)

    def test_invalid_channel_is_rejected_before_streamlink(self):
        response = direct.stream_url(self.request('bad-channel'))

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response_json(response)['error'], 'Invalid Twitch channel.')

    def test_resolve_stream_url_returns_selected_stream_and_qualities(self):
        fake_session = mock.Mock()
        fake_session.streams.return_value = {
            'best': SimpleNamespace(url='https://video.example/best.m3u8'),
            '720p': SimpleNamespace(url='https://video.example/720.m3u8'),
            'worst': SimpleNamespace(url='https://video.example/worst.m3u8'),
            '720p_alt': SimpleNamespace(url='https://video.example/alt.m3u8'),
        }

        with mock.patch.object(direct, 'Streamlink', return_value=fake_session):
            result = direct._resolve_stream_url('gamesdonequick', '720p')

        self.assertEqual(result['channel'], 'gamesdonequick')
        self.assertEqual(result['quality'], '720p')
        self.assertEqual(result['url'], 'https://video.example/720.m3u8')
        self.assertEqual(result['qualities'], ['720p'])
        fake_session.set_option.assert_called_once_with('http-timeout', 15.0)

    def test_failed_resolution_reports_confirmed_offline_channel(self):
        with mock.patch.object(direct, '_resolve_stream_url', side_effect=RuntimeError('resolver failed')):
            with mock.patch.object(direct, 'channel_is_live', return_value=False):
                response = direct.stream_url(self.request('offlinechannel'))

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response_json(response)['error'], 'Stream offline.')

    def test_failed_resolution_preserves_error_for_live_channel(self):
        with mock.patch.object(direct, '_resolve_stream_url', side_effect=RuntimeError('resolver failed')):
            with mock.patch.object(direct, 'channel_is_live', return_value=True):
                response = direct.stream_url(self.request('livechannel'))

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response_json(response)['error'], 'resolver failed')


class HlsProxyTests(unittest.TestCase):
    def test_allowlist_accepts_twitch_https_hosts_only(self):
        self.assertTrue(direct._is_allowed_hls_url('https://aps23.playlist.ttvnw.net/v1/playlist/x.m3u8'))
        self.assertTrue(direct._is_allowed_hls_url('https://ttvnw.net/x.m3u8'))
        # Wrong scheme, unrelated host, and lookalike hosts must be rejected.
        self.assertFalse(direct._is_allowed_hls_url('http://aps23.playlist.ttvnw.net/x.m3u8'))
        self.assertFalse(direct._is_allowed_hls_url('https://example.com/x.m3u8'))
        self.assertFalse(direct._is_allowed_hls_url('https://evilttvnw.net/x.m3u8'))
        self.assertFalse(direct._is_allowed_hls_url('https://ttvnw.net.attacker.com/x.m3u8'))
        self.assertFalse(direct._is_allowed_hls_url('https://127.0.0.1/x.m3u8'))

    def test_rewrite_proxies_nested_playlists_but_keeps_segments_direct(self):
        base = 'https://aps23.playlist.ttvnw.net/v1/playlist/abc.m3u8'
        body = '\n'.join([
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=6000000',
            'source.m3u8',
            '#EXT-X-TARGETDURATION:6',
            '#EXTINF:2.0,',
            'https://cdn.hls.ttvnw.net/seg-1.ts',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:2.0,',
            'seg-2.ts',
        ])

        result = direct._rewrite_playlist(body, base).split('\n')

        self.assertEqual(result[0], '#EXTM3U')
        self.assertIn('/api/hls-proxy?url=', result[1])
        self.assertTrue(result[3].startswith('/api/hls-proxy?url='))
        self.assertEqual(result[6], 'https://cdn.hls.ttvnw.net/seg-1.ts')
        self.assertIn('URI="https://aps23.playlist.ttvnw.net/v1/playlist/init.mp4"', result[7])
        self.assertEqual(result[9], 'https://aps23.playlist.ttvnw.net/v1/playlist/seg-2.ts')

    def test_missing_or_disallowed_url_returns_400(self):
        missing = direct.hls_proxy(SimpleNamespace(params={}))
        self.assertEqual(missing.status_code, 400)

        disallowed = direct.hls_proxy(SimpleNamespace(params={'url': 'https://example.com/x.m3u8'}))
        self.assertEqual(disallowed.status_code, 400)

    def test_proxy_returns_playlist_body_with_no_store(self):
        playlist = b'#EXTM3U\nhttps://cdn.hls.ttvnw.net/seg-1.ts\n'
        fake_upstream = mock.MagicMock()
        fake_upstream.read.return_value = playlist
        fake_upstream.geturl.return_value = 'https://aps23.playlist.ttvnw.net/v1/playlist/abc.m3u8'
        fake_upstream.__enter__.return_value = fake_upstream
        fake_upstream.__exit__.return_value = False

        with mock.patch.object(direct, 'urlopen', return_value=fake_upstream):
            response = direct.hls_proxy(SimpleNamespace(
                params={'url': 'https://aps23.playlist.ttvnw.net/v1/playlist/abc.m3u8'}
            ))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content_type, 'application/vnd.apple.mpegurl')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertIn('https://cdn.hls.ttvnw.net/seg-1.ts', response.text)


class TwitchViewTests(unittest.TestCase):
    def test_channel_is_live_uses_stream_presence(self):
        with mock.patch.object(twitch, '_gql_request', return_value={
            'data': {'user': {'stream': {'id': '123'}}},
        }):
            self.assertTrue(twitch.channel_is_live('livechannel'))

        with mock.patch.object(twitch, '_gql_request', return_value={
            'data': {'user': {'stream': None}},
        }):
            self.assertFalse(twitch.channel_is_live('offlinechannel'))

    def test_live_status_rejects_invalid_channel(self):
        request = SimpleNamespace(matchdict={'channel': 'bad-channel'})

        response = twitch.live_status(request)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response_json(response)['error'], 'Invalid Twitch channel.')

    def test_safe_return_to_rejects_external_or_protocol_relative_urls(self):
        self.assertEqual(twitch._safe_return_to('https://example.com'), '/')
        self.assertEqual(twitch._safe_return_to('//example.com/path'), '/')
        self.assertEqual(twitch._safe_return_to('/gamesdonequick?darkmode=1'), '/gamesdonequick?darkmode=1')

    def test_sqlite_session_round_trip_and_delete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, 'sessions.sqlite3')
            request = SimpleNamespace(
                registry=SimpleNamespace(settings={
                    'twitch.client_id': '',
                    'twitch.client_secret': '',
                    'twitch.redirect_uri': '',
                    'twitch.session_db': db_path,
                }),
                host_url='http://localhost:6543',
            )
            session = {'id': 'session-id', 'token': {'access_token': 'token'}}

            twitch._save_session(request, 'session-id', session)
            loaded = twitch._load_session(request, 'session-id')
            twitch._delete_session(request, 'session-id')

            self.assertEqual(loaded, {'token': {'access_token': 'token'}})
            self.assertIsNone(twitch._load_session(request, 'session-id'))


if __name__ == '__main__':
    unittest.main()
