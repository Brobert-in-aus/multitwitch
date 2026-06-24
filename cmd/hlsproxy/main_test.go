package main

import (
	"strings"
	"testing"
)

func TestIsAllowedHLSURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://video-weaver.aps23.hls.ttvnw.net/v1/playlist/abc.m3u8", true},
		{"https://ttvnw.net/x", true},
		{"http://video-weaver.aps23.hls.ttvnw.net/v1/playlist/abc.m3u8", false}, // not https
		{"https://evilttvnw.net/x", false},                                      // suffix match, not subdomain
		{"https://ttvnw.net.evil.com/x", false},
		{"not-a-url", false},
		{"", false},
	}
	for _, c := range cases {
		if got := isAllowedHLSURL(c.url); got != c.want {
			t.Errorf("isAllowedHLSURL(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

func TestPyQuote(t *testing.T) {
	cases := map[string]string{
		"hello":               "hello",
		"a b":                 "a%20b",
		"a/b":                 "a%2Fb",
		"a-b_c.d~e":           "a-b_c.d~e",
		"https://x.com/y?z=1": "https%3A%2F%2Fx.com%2Fy%3Fz%3D1",
	}
	for in, want := range cases {
		if got := pyQuote(in); got != want {
			t.Errorf("pyQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRewritePlaylistVariant(t *testing.T) {
	body := strings.Join([]string{
		`#EXTM3U`,
		`#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES`,
		`#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,VIDEO="720p60"`,
		`https://aps23.playlist.ttvnw.net/v1/playlist/AAA.m3u8`,
		`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="https://aps23.playlist.ttvnw.net/v1/playlist/AUDIO.m3u8"`,
	}, "\n")

	got := rewritePlaylist(body, "https://usher.ttvnw.net/api/channel/hls/foo.m3u8")
	lines := strings.Split(got, "\n")

	if lines[0] != "#EXTM3U" {
		t.Errorf("line 0 changed: %q", lines[0])
	}
	// The variant URI following #EXT-X-STREAM-INF must be rewritten to the
	// local proxy path (it's a nested playlist).
	if !strings.HasPrefix(lines[3], "/api/hls-proxy?url=") {
		t.Errorf("variant URI not rewritten to proxy path: %q", lines[3])
	}
	if !strings.Contains(lines[3], pyQuote("https://aps23.playlist.ttvnw.net/v1/playlist/AAA.m3u8")) {
		t.Errorf("variant URI missing expected encoded target: %q", lines[3])
	}
	// The URI= attribute on an #EXT-X-MEDIA line is also a nested playlist
	// and must be rewritten in place.
	if !strings.Contains(lines[4], `URI="/api/hls-proxy?url=`) {
		t.Errorf("EXT-X-MEDIA URI attribute not rewritten: %q", lines[4])
	}
}

func TestRewritePlaylistSegmentsStayDirect(t *testing.T) {
	body := strings.Join([]string{
		`#EXTM3U`,
		`#EXT-X-TARGETDURATION:6`,
		`#EXTINF:2.000,live`,
		`https://video-edge.cloudfront.hls.ttvnw.net/v1/segment/AAA.ts`,
	}, "\n")

	got := rewritePlaylist(body, "https://aps23.playlist.ttvnw.net/v1/playlist/AAA.m3u8")
	lines := strings.Split(got, "\n")

	// A plain segment URI (no preceding #EXT-X-STREAM-INF) must stay a
	// direct, absolute Twitch CDN URL -- never routed through the proxy --
	// so video bytes bypass this server entirely.
	if strings.Contains(lines[3], "/api/hls-proxy") {
		t.Errorf("segment URI incorrectly proxied: %q", lines[3])
	}
	if lines[3] != "https://video-edge.cloudfront.hls.ttvnw.net/v1/segment/AAA.ts" {
		t.Errorf("segment URI unexpectedly altered: %q", lines[3])
	}
}

func TestRewritePlaylistPrefetchPromotedToSegment(t *testing.T) {
	body := strings.Join([]string{
		`#EXTM3U`,
		`#EXTINF:2.500,live`,
		`https://video-edge.cloudfront.hls.ttvnw.net/v1/segment/AAA.ts`,
		`#EXT-X-TWITCH-PREFETCH:https://video-edge.cloudfront.hls.ttvnw.net/v1/segment/BBB.ts`,
	}, "\n")

	got := rewritePlaylist(body, "https://aps23.playlist.ttvnw.net/v1/playlist/AAA.m3u8")
	lines := strings.Split(got, "\n")

	// The prefetch tag should be promoted to a normal #EXTINF segment using
	// the duration of the last real segment (2.500s here), and the
	// segment itself must remain a direct CDN link.
	if lines[len(lines)-2] != "#EXTINF:2.500," {
		t.Errorf("prefetch not promoted with carried-over duration: %q", lines[len(lines)-2])
	}
	if lines[len(lines)-1] != "https://video-edge.cloudfront.hls.ttvnw.net/v1/segment/BBB.ts" {
		t.Errorf("prefetch segment URI altered: %q", lines[len(lines)-1])
	}
}

func TestPlaylistCacheTTL(t *testing.T) {
	c := newPlaylistCache()
	c.set("https://x/y.m3u8", "body")
	got, ok := c.get("https://x/y.m3u8")
	if !ok || got != "body" {
		t.Fatalf("expected cache hit, got ok=%v body=%q", ok, got)
	}
	if _, ok := c.get("https://x/missing.m3u8"); ok {
		t.Fatalf("expected cache miss for unknown key")
	}
}
