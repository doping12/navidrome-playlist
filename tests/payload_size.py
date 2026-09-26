"""Measure the real /api/library response through the fake Navidrome server."""
from __future__ import annotations

import gzip
import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

from navidrome_playlist.library import Library
from navidrome_playlist.navidrome import NavidromeClient
from navidrome_playlist.server import App, make_handler
try:
    from tests.fake_navidrome import make_server
except ModuleNotFoundError:
    from fake_navidrome import make_server


def main():
    try:
        fake = make_server(10000)
    except PermissionError as error:
        print(json.dumps({"skipped": f"local HTTP sockets unavailable: {error}"})); return
    fake_thread = threading.Thread(target=fake.serve_forever, daemon=True); fake_thread.start()
    client = NavidromeClient(f"http://127.0.0.1:{fake.server_port}", "test", "test")
    library = Library(client)
    app_server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(App(library)))
    app_thread = threading.Thread(target=app_server.serve_forever, daemon=True); app_thread.start()
    url = f"http://127.0.0.1:{app_server.server_port}/api/library"
    try:
        start = time.perf_counter()
        with urllib.request.urlopen(url) as response: raw = response.read()
        raw_ms = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        request = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(request) as response: compressed = response.read()
        gzip_ms = (time.perf_counter() - start) * 1000
        print(json.dumps({"songs": 10000, "rawBytes": len(raw), "gzipBytes": len(compressed), "rawRequestMs": round(raw_ms, 2), "gzipRequestMs": round(gzip_ms, 2)}))
    finally:
        app_server.shutdown(); fake.shutdown(); app_server.server_close(); fake.server_close()


if __name__ == "__main__": main()
