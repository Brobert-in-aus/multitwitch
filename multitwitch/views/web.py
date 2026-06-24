import re
from urllib.parse import urlencode

from multitwitch.lib.session import web, ajax
from pyramid.response import FileResponse, Response

# Stream sync is hidden for now on the production domain only -- it stays
# available on multistream.robertmckinnon.au (and local dev) for continued
# testing. Remove this once the feature is ready to ship everywhere again.
STREAM_SYNC_HIDDEN_ON = {'streammulti.live'}

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
        return {'project' : 'StreamMulti',
                'streams' : uniq_streams,
                'unique_streams' : uniq_streams,
                'nstreams' : len(uniq_streams),
                'darkmode' : darkmode,
                'twitch_parent_query' : twitch_parent_query,
                'show_stream_sync' : request.domain not in STREAM_SYNC_HIDDEN_ON}

    @staticmethod
    def healthz(request):
        return Response('ok', content_type='text/plain')

    @staticmethod
    def favicon(request):
        return FileResponse("multitwitch/static/favicon.ico", content_type="image/x-icon")
