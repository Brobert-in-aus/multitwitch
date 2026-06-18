import re
from urllib.parse import urlencode

from multitwitch.lib.session import web, ajax
from pyramid.response import FileResponse, Response

class WebView:
    @web(template="web/home.tmpl")
    def home(request):
        streams = request.matchdict['streams']
        darkmode = 'darkmode' in request.params
        parent_domain = request.domain
        twitch_parent_query = urlencode([('parent', parent_domain)])
        uniq_streams = []
        for s in streams:
            normalized = s.strip().lower()
            if re.match(r'^[A-Za-z0-9_]{1,25}$', normalized) and normalized not in uniq_streams:
                uniq_streams.append(normalized)
        return {'project' : 'multitwitch',
                'streams' : uniq_streams,
                'unique_streams' : uniq_streams,
                'nstreams' : len(uniq_streams),
                'darkmode' : darkmode,
                'twitch_parent_query' : twitch_parent_query}

    @staticmethod
    def healthz(request):
        return Response('ok', content_type='text/plain')

    @staticmethod
    def favicon(request):
        return FileResponse("multitwitch/static/favicon.ico", content_type="image/x-icon")
