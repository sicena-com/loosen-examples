// front serves the hosted demo, https://loosen.sicena.com/demo/ (the loosen shop proxies /demo/ to it with the prefix stripped, so
// every path below is relative to the demo root). It listens on a loopback port. Go standard library only.
//
//	/            the static examples (an allow-list of paths: landing, examples/, assets/, vendor/, data/, a few source files, config.js)
//	/shop/       the server-rendered shop (cmd/shop, a separate process on a loopback port)
//	/api/        ONLY  POST /api/v1/catalogs/<catalog>/explain  ->  loosend's  POST /v1/catalogs/<catalog>/explain  (loopback)
//	/health      the monitor's endpoint: needs X-Health-Token, probes loosend (health + one explain call) and the shop
//
// Nothing else of loosend is reachable (no /health, no admin routes, no other catalog): the front is the only thing that
// listens on a public interface. Every response carries Cache-Control: no-cache (the site is in beta, see deploy/README.md).
//
//	go run ./cmd/front -addr 127.0.0.1:8081 -root . -loosend http://127.0.0.1:8130 -shop http://127.0.0.1:8124
package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

const (
	maxBody    = 8 << 10 // an explain request is a few hundred bytes (at most 24 constraints)
	serviceTag = "loosen-examples"
)

// public are the only files and folders that the static handler serves (the build copies nothing else either).
var publicDirs = []string{"/assets/", "/vendor/", "/data/", "/examples/", "/docs/img/"}
var publicFiles = map[string]bool{
	"/index.html": true, "/config.js": true,
	"/cmd/shop/main.go": true, "/scripts/run-loosend.sh": true, "/scripts/load-catalog.sh": true, // shown in the "Source" blocks
}

type front struct {
	root, catalog, readKey string
	loosend, shop          *url.URL
	hops                   int
	healthToken            string
	limiter                *limiter
	static                 http.Handler
	explain, shopProxy     *httputil.ReverseProxy
	client                 *http.Client
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8081", "listen address (the only public one)")
	root := flag.String("root", ".", "folder with the examples (index.html, examples/, assets/, vendor/, data/, config.js)")
	loosend := flag.String("loosend", "http://127.0.0.1:8130", "loosend (loopback)")
	shop := flag.String("shop", "http://127.0.0.1:8124", "cmd/shop (loopback)")
	catalog := flag.String("catalog", "apartments", "the one catalog whose explain route is public")
	readKey := flag.String("read-key", "examples-read-key", "read key used by the health probe (it is public: it is in the page)")
	hops := flag.Int("hops", 1, "proxies that append to X-Forwarded-For before a request reaches this server")
	perMinute := flag.Int("rate", 120, "explain requests per minute per client IP (loosend has its own limit as well)")
	burst := flag.Int("burst", 40, "explain burst per client IP")
	flag.Parse()

	f, err := newFront(*root, *loosend, *shop, *catalog, *readKey, os.Getenv("HEALTH_TOKEN"), *hops, *perMinute, *burst)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("front on %s (root %s, loosend %s, shop %s)", *addr, *root, *loosend, *shop)
	srv := &http.Server{Addr: *addr, Handler: f, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func newFront(root, loosend, shop, catalog, readKey, healthToken string, hops, perMinute, burst int) (*front, error) {
	if healthToken == "" {
		return nil, fmt.Errorf("HEALTH_TOKEN is not set")
	}
	lu, err := url.Parse(loosend)
	if err != nil {
		return nil, err
	}
	su, err := url.Parse(shop)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(path.Join(root, "index.html")); err != nil {
		return nil, err
	}
	f := &front{root: root, catalog: catalog, readKey: readKey, loosend: lu, shop: su, hops: hops, healthToken: healthToken,
		limiter: newLimiter(float64(perMinute)/60, burst), client: &http.Client{Timeout: 4 * time.Second}}
	f.static = http.FileServer(noDirs{http.Dir(root)})
	f.explain = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(lu)
			r.Out.URL.Path = strings.TrimPrefix(r.In.URL.Path, "/api")
			r.Out.URL.RawQuery = ""
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("Authorization") // nothing a visitor sends can ever carry an admin key to loosend
			r.Out.Header.Set("X-Forwarded-For", f.clientIP(r.In))
		},
		ModifyResponse: func(resp *http.Response) error { resp.Header.Set("Cache-Control", "no-cache"); return nil },
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				jsonError(w, 413, "body_too_large")
				return
			}
			jsonError(w, 502, "upstream_unavailable")
		},
	}
	f.shopProxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(su)
			r.Out.URL.Path = "/" // the shop is one page; its assets come from this front, with absolute paths
			r.Out.Header.Del("Cookie")
		},
		ModifyResponse: func(resp *http.Response) error { resp.Header.Set("Cache-Control", "no-cache"); return nil },
		ErrorHandler:   func(w http.ResponseWriter, r *http.Request, err error) { http.Error(w, "shop unavailable", 502) },
	}
	return f, nil
}

func (f *front) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-cache") // beta rule, on every response including errors
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	p := path.Clean("/" + r.URL.Path)
	switch {
	case p == "/health":
		f.health(w, r)
	case strings.HasPrefix(p, "/api/") || p == "/api":
		f.api(w, r, p)
	case r.URL.Path == "/shop":
		target := "/shop/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	case r.URL.Path == "/shop/":
		if !readOnly(w, r) {
			return
		}
		w.Header().Del("Cache-Control")
		f.shopProxy.ServeHTTP(w, r)
	case p == "/shop" || strings.HasPrefix(p, "/shop/"):
		http.NotFound(w, r) // the shop is one page
	default:
		f.serveStatic(w, r, p)
	}
}

func readOnly(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func (f *front) serveStatic(w http.ResponseWriter, r *http.Request, p string) {
	if !readOnly(w, r) {
		return
	}
	ok := p == "/" || publicFiles[p]
	for _, d := range publicDirs {
		ok = ok || strings.HasPrefix(p, d)
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(p, ".mjs") {
		w.Header().Set("Content-Type", "text/javascript")
	}
	f.static.ServeHTTP(w, r)
}

// api lets exactly one request through: POST (or the preflight OPTIONS) of the public explain route of one catalog.
func (f *front) api(w http.ResponseWriter, r *http.Request, p string) {
	if p != "/api/v1/catalogs/"+f.catalog+"/explain" {
		jsonError(w, 404, "not_found")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodOptions {
		w.Header().Set("Allow", "POST, OPTIONS")
		jsonError(w, 405, "method_not_allowed")
		return
	}
	if !f.limiter.allow(f.clientIP(r)) {
		w.Header().Set("Retry-After", "1")
		jsonError(w, 429, "rate_limited")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	w.Header().Del("Cache-Control") // the proxy copies the response headers; ModifyResponse sets no-cache once
	f.explain.ServeHTTP(w, r)
}

// clientIP is the address the Nth proxy from the end of X-Forwarded-For saw (same rule as loosen.sicena.com: CLIENT_IP_HOPS).
func (f *front) clientIP(r *http.Request) string {
	if parts := strings.Split(r.Header.Get("X-Forwarded-For"), ","); f.hops > 0 && len(parts) >= f.hops {
		if ip := strings.TrimSpace(parts[len(parts)-f.hops]); net.ParseIP(ip) != nil {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// health needs the shared health token (like every service) and checks what the demo depends on: loosend holds the catalog and
// answers the public explain call, and the shop answers.
func (f *front) health(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Health-Token")), []byte(f.healthToken)) != 1 {
		jsonError(w, 401, "unauthorized")
		return
	}
	problem := f.probe()
	w.Header().Set("Content-Type", "application/json")
	if problem != "" {
		w.WriteHeader(503)
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "service": serviceTag, "problem": problem})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": serviceTag})
}

func (f *front) probe() string {
	resp, err := f.client.Get(f.loosend.String() + "/health")
	if err != nil {
		return "loosend: " + err.Error()
	}
	var h struct {
		Items int `json:"items"`
	}
	json.NewDecoder(resp.Body).Decode(&h)
	resp.Body.Close()
	if resp.StatusCode != 200 || h.Items < 1 {
		return fmt.Sprintf("loosend health: status %d, %d items", resp.StatusCode, h.Items)
	}
	body := `{"constraints":[{"attr":"rent","op":"le","value":0}]}`
	req, _ := http.NewRequest("POST", f.loosend.String()+"/v1/catalogs/"+f.catalog+"/explain", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Loosen-Key", f.readKey)
	req.Header.Set("X-Forwarded-For", "127.0.0.1")
	resp, err = f.client.Do(req)
	if err != nil {
		return "explain: " + err.Error()
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Sprintf("explain: status %d", resp.StatusCode)
	}
	resp, err = f.client.Get(f.shop.String() + "/")
	if err != nil {
		return "shop: " + err.Error()
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Sprintf("shop: status %d", resp.StatusCode)
	}
	return ""
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"error":%q}`+"\n", msg)
}

// noDirs makes http.FileServer refuse directory listings (a folder without index.html is a 404).
type noDirs struct{ fs http.FileSystem }

func (n noDirs) Open(name string) (http.File, error) {
	f, err := n.fs.Open(name)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if st.IsDir() {
		idx, err := n.fs.Open(path.Join(name, "index.html"))
		if err != nil {
			f.Close()
			return nil, fs.ErrNotExist
		}
		idx.Close()
	}
	return f, nil
}

// limiter is a token bucket per client IP.
type limiter struct {
	mu    sync.Mutex
	rate  float64
	burst float64
	m     map[string]*bucket
	last  time.Time
}
type bucket struct {
	tokens float64
	at     time.Time
}

func newLimiter(rate float64, burst int) *limiter {
	return &limiter{rate: rate, burst: float64(burst), m: map[string]*bucket{}, last: time.Now()}
}

func (l *limiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.last) > 5*time.Minute { // forget idle clients
		for k, b := range l.m {
			if now.Sub(b.at) > 5*time.Minute {
				delete(l.m, k)
			}
		}
		l.last = now
	}
	b := l.m[ip]
	if b == nil {
		b = &bucket{tokens: l.burst, at: now}
		l.m[ip] = b
	}
	b.tokens += now.Sub(b.at).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
