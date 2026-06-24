// hlsproxy is a stateless sidecar that replaces the Python /api/hls-proxy
// handler in multitwitch/views/direct.py under heavier concurrency.
//
// Twitch's playlist hosts (*.ttvnw.net) 403 any request that carries a
// cross-origin browser Origin header, regardless of CORS headers -- so
// hls.js can't fetch playlists directly from a non-twitch.tv page. Fetching
// server-side (no Origin header) works; segment/key/init URIs stay direct
// Twitch CDN links since those hosts don't apply the same check, so video
// bytes never transit this proxy. See direct.py's hls_proxy for the
// behavior this mirrors exactly -- same allowlist, same path contract
// (/api/hls-proxy?url=...), same playlist rewriting rules.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	playlistContentType = "application/vnd.apple.mpegurl; charset=UTF-8"
	prefetchTag         = "#EXT-X-TWITCH-PREFETCH:"
	cacheTTL            = 1500 * time.Millisecond
	cacheSweepInterval  = 5 * time.Second
	upstreamTimeout     = 10 * time.Second
)

var (
	hlsURIAttrRe = regexp.MustCompile(`URI="([^"]+)"`)
	extinfRe     = regexp.MustCompile(`^#EXTINF:([0-9]*\.?[0-9]+)`)

	// Shared, pooled HTTP client: keep-alive + TLS session reuse across
	// repeated polls to the same Twitch weaver host, instead of a fresh
	// TCP+TLS handshake every 2-4s per playing tile.
	httpClient = &http.Client{
		Timeout: upstreamTimeout,
		Transport: &http.Transport{
			MaxIdleConns:        200,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
			ForceAttemptHTTP2:   true,
		},
	}
)

// pyUnreserved mirrors Python's urllib.parse.quote(s, safe="") character
// set (RFC 3986 unreserved characters). Matching it byte-for-byte keeps the
// rewritten /api/hls-proxy?url=... links identical to what the Python
// proxy and the frontend's own hls_proxy_path() already produce.
const pyUnreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~"

func pyQuote(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if strings.IndexByte(pyUnreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func hlsProxyPath(rawURL string) string {
	return "/api/hls-proxy?url=" + pyQuote(rawURL)
}

// isAllowedHLSURL allowlists Twitch hosts only: this endpoint fetches
// arbitrary URLs, so an open allowlist would make it an SSRF/open proxy.
func isAllowedHLSURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	if u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "ttvnw.net" || strings.HasSuffix(host, ".ttvnw.net")
}

func rewriteHLSURI(uri, baseURL string, playlist bool) string {
	absolute := resolveReference(baseURL, uri)
	if playlist {
		return hlsProxyPath(absolute)
	}
	return absolute
}

func resolveReference(baseURL, ref string) string {
	base, err := url.Parse(baseURL)
	if err != nil {
		return ref
	}
	r, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return base.ResolveReference(r).String()
}

// rewritePlaylist keeps every master/alternate playlist same-origin so
// hls.js's subsequent fetches stay routed through this proxy. Segments,
// keys, and init files remain direct Twitch CDN URLs, so their bandwidth
// bypasses this server entirely.
//
// Twitch advertises its true live edge via proprietary
// #EXT-X-TWITCH-PREFETCH tags that hls.js doesn't understand; those are
// promoted to normal #EXTINF segments so hls.js reaches the true edge
// instead of sitting needlessly behind it.
func rewritePlaylist(body, baseURL string) string {
	lines := strings.Split(body, "\n")
	out := make([]string, 0, len(lines))

	nextURIIsPlaylist := false
	lastSegmentDuration := 2.0
	haveDuration := false

	for _, line := range lines {
		stripped := strings.TrimSpace(line)

		if strings.HasPrefix(stripped, prefetchTag) {
			prefetchURI := strings.TrimSpace(stripped[len(prefetchTag):])
			if prefetchURI != "" {
				duration := 2.0
				if haveDuration {
					duration = lastSegmentDuration
				}
				out = append(out, fmt.Sprintf("#EXTINF:%.3f,", duration))
				out = append(out, rewriteHLSURI(prefetchURI, baseURL, false))
			}
			continue
		}

		if stripped != "" && !strings.HasPrefix(stripped, "#") {
			out = append(out, rewriteHLSURI(stripped, baseURL, nextURIIsPlaylist))
			nextURIIsPlaylist = false
			continue
		}

		if m := extinfRe.FindStringSubmatch(stripped); m != nil {
			if v, err := strconv.ParseFloat(m[1], 64); err == nil {
				lastSegmentDuration = v
				haveDuration = true
			}
		}

		tagHasPlaylistURI := strings.HasPrefix(stripped, "#EXT-X-MEDIA:") ||
			strings.HasPrefix(stripped, "#EXT-X-I-FRAME-STREAM-INF:")

		rewritten := hlsURIAttrRe.ReplaceAllStringFunc(line, func(match string) string {
			sub := hlsURIAttrRe.FindStringSubmatch(match)
			return `URI="` + rewriteHLSURI(sub[1], baseURL, tagHasPlaylistURI) + `"`
		})
		out = append(out, rewritten)
		nextURIIsPlaylist = strings.HasPrefix(stripped, "#EXT-X-STREAM-INF:")
	}

	return strings.Join(out, "\n")
}

type cacheEntry struct {
	body      string
	expiresAt time.Time
}

type playlistCache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
}

func newPlaylistCache() *playlistCache {
	return &playlistCache{entries: make(map[string]cacheEntry)}
}

func (c *playlistCache) get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expiresAt) {
		return "", false
	}
	return e.body, true
}

func (c *playlistCache) set(key, body string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = cacheEntry{body: body, expiresAt: time.Now().Add(cacheTTL)}
}

// sweep deletes expired entries so the map doesn't grow unbounded over the
// container's lifetime -- every resolved stream URL is distinct (Twitch
// embeds a fresh signed token roughly every 60s per channel), so without
// this the cache would otherwise retain every URL ever seen.
func (c *playlistCache) sweep() {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.entries {
		if now.After(e.expiresAt) {
			delete(c.entries, k)
		}
	}
}

func (c *playlistCache) startJanitor(interval time.Duration) {
	go func() {
		for {
			time.Sleep(interval)
			c.sweep()
		}
	}()
}

var cache = newPlaylistCache()

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func writePlaylist(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", playlistContentType)
	// Live playlists roll every few seconds -- never let the browser cache
	// this response (the short server-side cache above is a different,
	// internal optimization invisible to the client).
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
}

func fetchUpstream(rawURL string) (body, finalURL string, status int, err error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return "", "", 0, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", 0, err
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", 0, err
	}

	final := rawURL
	if resp.Request != nil && resp.Request.URL != nil {
		final = resp.Request.URL.String()
	}

	return strings.ToValidUTF8(string(b), "�"), final, resp.StatusCode, nil
}

func handleHLSProxy(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		writeJSONError(w, http.StatusBadRequest, "Missing url parameter.")
		return
	}
	if !isAllowedHLSURL(rawURL) {
		writeJSONError(w, http.StatusBadRequest, "URL host is not allowed.")
		return
	}

	if cached, ok := cache.get(rawURL); ok {
		writePlaylist(w, cached)
		return
	}

	body, finalURL, status, err := fetchUpstream(rawURL)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	if status >= 400 {
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("Upstream returned %d.", status))
		return
	}
	if !isAllowedHLSURL(finalURL) {
		writeJSONError(w, http.StatusBadGateway, "Upstream redirect host is not allowed.")
		return
	}

	rewritten := rewritePlaylist(body, finalURL)
	cache.set(rawURL, rewritten)
	writePlaylist(w, rewritten)
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, "ok")
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	cache.startJanitor(cacheSweepInterval)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/api/hls-proxy", handleHLSProxy)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  90 * time.Second,
	}

	log.Printf("hlsproxy listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}
