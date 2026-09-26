from __future__ import annotations

import gzip
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .library import Library
from .navidrome import NavidromeError

STATIC_DIR = Path(__file__).with_name("static").resolve()


class ApiFailure(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class App:
    def __init__(self, library: Library):
        self.library = library
        self.lock = threading.RLock()

    def json_body(self, handler):
        if "application/json" not in handler.headers.get("Content-Type", "").lower():
            raise ApiFailure("Content-Type: application/json が必要です", 415)
        try:
            length = int(handler.headers.get("Content-Length", "0"))
            if length > 10 * 1024 * 1024:
                raise ApiFailure("リクエストが大きすぎます", 413)
            return json.loads(handler.rfile.read(length))
        except ApiFailure:
            raise
        except (ValueError, json.JSONDecodeError) as exc:
            raise ApiFailure("JSONが不正です", 400) from exc

    def api(self, handler, method: str, path: str):
        try:
            if method == "GET" and path == "/api/library":
                return 200, self.library.payload()
            if method == "POST" and path == "/api/reload":
                self.json_body(handler)
                return 200, self.library.reload()
            if method == "POST" and path == "/api/playlists":
                body = self.json_body(handler)
                if not isinstance(body, dict):
                    raise ApiFailure("JSONオブジェクトが必要です")
                return 200, self.library.create(body.get("name"), body.get("songIds"))
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 4 and parts[:2] == ["api", "playlists"] and parts[3] in {"add", "remove"} and method == "POST":
                body = self.json_body(handler)
                if not isinstance(body, dict):
                    raise ApiFailure("JSONオブジェクトが必要です")
                try:
                    result = self.library.add(parts[2], body.get("songIds")) if parts[3] == "add" else self.library.remove(parts[2], body.get("songIds"))
                except PermissionError as exc:
                    raise ApiFailure(str(exc), 403) from exc
                return 200, result
            raise ApiFailure("Not found", 404)
        except PermissionError as exc:
            raise ApiFailure(str(exc), 403) from exc
        except ValueError as exc:
            raise ApiFailure(str(exc), 400) from exc
        except NavidromeError as exc:
            raise ApiFailure(str(exc), 502) from exc


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "navidrome-playlist/0.1"

        def log_message(self, format, *args):
            # Avoid request data (which could include credentials) in logs.
            super().log_message("%s", format % args)

        def send_json(self, status, payload):
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if "gzip" in self.headers.get("Accept-Encoding", "").lower():
                raw = gzip.compress(raw, compresslevel=6)
                self.send_response(status)
                self.send_header("Content-Encoding", "gzip")
            else:
                self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def do_api(self, method):
            path = urlsplit(self.path).path
            try:
                status, payload = app.api(self, method, path)
                self.send_json(status, payload)
            except ApiFailure as exc:
                self.send_json(exc.status, {"error": str(exc)})
            except Exception:
                self.send_json(500, {"error": "サーバー内部エラー"})

        def do_GET(self):
            if self.path.startswith("/api/"):
                return self.do_api("GET")
            path = urlsplit(self.path).path
            relative = "index.html" if path in {"", "/"} else path.removeprefix("/")
            file = (STATIC_DIR / relative).resolve()
            if STATIC_DIR not in file.parents or not file.is_file():
                self.send_error(404)
                return
            data = file.read_bytes()
            content_type = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
            if "gzip" in self.headers.get("Accept-Encoding", "").lower() and content_type in {"text/html", "text/css", "text/javascript", "application/javascript"}:
                data = gzip.compress(data, compresslevel=6)
                encoding = "gzip"
            else:
                encoding = None
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            if encoding:
                self.send_header("Content-Encoding", encoding)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path.startswith("/api/"):
                return self.do_api("POST")
            self.send_error(404)

    return Handler


def serve(library: Library, host: str, port: int):
    app = App(library)
    server = ThreadingHTTPServer((host, port), make_handler(app))
    print(f"navidrome-playlist listening on http://{host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
