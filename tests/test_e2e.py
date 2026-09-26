from __future__ import annotations

import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from navidrome_playlist.library import Library
from navidrome_playlist.navidrome import NavidromeClient
from navidrome_playlist.server import App, make_handler
from tests.fake_navidrome import make_server


def call_json(url, method="GET", body=None):
    request = urllib.request.Request(url, method=method, headers={"Content-Type": "application/json"} if body is not None else {})
    if body is not None: request.data = json.dumps(body).encode()
    with urllib.request.urlopen(request) as response:
        return response.status, json.load(response)


def test_fake_navidrome_and_app_api_end_to_end():
    try:
        fake = make_server(song_count=25)
    except PermissionError as error:
        pytest.skip(f"この実行環境ではローカルHTTPソケットを作成できません: {error}")
    fake_thread = threading.Thread(target=fake.serve_forever, daemon=True); fake_thread.start()
    client = NavidromeClient(f"http://127.0.0.1:{fake.server_port}", "test", "test")
    library = Library(client)
    app_server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(App(library)))
    app_thread = threading.Thread(target=app_server.serve_forever, daemon=True); app_thread.start()
    base = f"http://127.0.0.1:{app_server.server_port}"
    try:
        status, payload = call_json(f"{base}/api/library")
        assert status == 200 and len(payload["songs"]) == 25
        status, result = call_json(f"{base}/api/playlists/p1/add", "POST", {"songIds": ["s000000", "s000001"]})
        assert status == 200 and result["added"] == 2
        _, repeat = call_json(f"{base}/api/playlists/p1/add", "POST", {"songIds": ["s000000", "s000001"]})
        assert repeat["added"] == 0 and repeat["skipped"] == 2
        _, removed = call_json(f"{base}/api/playlists/p1/remove", "POST", {"songIds": ["s000000", "s000001"]})
        assert removed["removed"] == 2
    finally:
        app_server.shutdown(); fake.shutdown(); app_server.server_close(); fake.server_close()
