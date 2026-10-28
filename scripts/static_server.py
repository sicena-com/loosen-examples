#!/usr/bin/env python3
"""A tiny static file server for the examples: correct MIME types for .mjs, no caching, localhost only by default.
Usage: python3 scripts/static_server.py [PORT] [BIND]     (serves the repository root)"""
import functools, http.server, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".csv": "text/csv"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET") != "1":
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    bind = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    server = http.server.ThreadingHTTPServer((bind, port), functools.partial(Handler, directory=ROOT))
    print(f"examples on http://localhost:{port}/  (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
