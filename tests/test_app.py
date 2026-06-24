import unittest

from multitwitch import _trust_forwarded_headers


class TrustForwardedHeadersTests(unittest.TestCase):
    def call(self, environ):
        captured = {}

        def inner_app(env, start_response):
            captured['environ'] = env
            start_response('200 OK', [])
            return [b'']

        wrapped = _trust_forwarded_headers(inner_app)
        wrapped(environ, lambda status, headers: None)
        return captured['environ']

    def test_rewrites_scheme_and_host_from_forwarded_headers(self):
        environ = self.call({
            'wsgi.url_scheme': 'http',
            'HTTP_HOST': 'multistream:6543',
            'HTTP_X_FORWARDED_PROTO': 'https',
            'HTTP_X_FORWARDED_HOST': 'streammulti.live',
        })

        self.assertEqual(environ['wsgi.url_scheme'], 'https')
        self.assertEqual(environ['HTTP_HOST'], 'streammulti.live')

    def test_leaves_environ_alone_without_forwarded_headers(self):
        environ = self.call({
            'wsgi.url_scheme': 'http',
            'HTTP_HOST': 'localhost:6543',
        })

        self.assertEqual(environ['wsgi.url_scheme'], 'http')
        self.assertEqual(environ['HTTP_HOST'], 'localhost:6543')

    def test_uses_first_value_when_header_has_multiple(self):
        environ = self.call({
            'wsgi.url_scheme': 'http',
            'HTTP_HOST': 'multistream:6543',
            'HTTP_X_FORWARDED_PROTO': 'https, http',
            'HTTP_X_FORWARDED_HOST': 'multistream.robertmckinnon.au, internal',
        })

        self.assertEqual(environ['wsgi.url_scheme'], 'https')
        self.assertEqual(environ['HTTP_HOST'], 'multistream.robertmckinnon.au')


if __name__ == '__main__':
    unittest.main()
