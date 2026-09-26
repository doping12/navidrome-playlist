"""Small in-process Navidrome API emulator used by browser/API tests."""
from __future__ import annotations

import argparse
import json
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


def synthetic_song(index: int) -> dict:
    japanese = index % 4 == 0
    return {
        "id": f"s{index:06d}", "title": f"曲 {index:05d}" if japanese else f"Song {index:05d}",
        "album": f"アルバム {index % 500}" if japanese else f"Album {index % 500}",
        "artist": f"アーティスト {index % 300}" if japanese else f"Artist {index % 300}",
        "albumArtist": f"アルバム作者 {index % 120}" if japanese else f"Album Artist {index % 120}",
        "releaseDate": f"{1950 + index % 75:04d}-{index % 12 + 1:02d}-{index % 27 + 1:02d}",
        "date": f"{1950 + index % 75:04d}", "year": 1950 + index % 75,
        "originalYear": 1940 + index % 80, "releaseYear": 1950 + index % 75,
        "trackNumber": index % 15 + 1, "discNumber": index % 3 + 1, "duration": 150 + index % 300,
        "genre": "Rock" if index % 2 else "ポップ", "genres": [{"name": "Rock" if index % 2 else "ポップ"}],
        "tags": {"recordlabel": [f"Label {index % 20}"], "mood": ["calm" if index % 2 else "bright"]},
        "participants": {"composer": [{"name": f"Composer {index % 70}"}], "artist": [{"name": f"Artist {index % 300}"}]},
        "suffix": "mp3" if index % 2 else "flac", "size": 1_000_000 + index * 101,
        "duration": 180 + index % 240, "bitRate": 128_000 + index % 4 * 64_000,
        "sampleRate": 44_100, "bitDepth": 16, "channels": 2, "bpm": 80 + index % 80,
        "rgTrackGain": -8.0 + (index % 100) / 10, "rgAlbumPeak": 0.8 + (index % 20) / 100,
        "sortTitle": f"{index:06d}", "sortAlbumName": f"{index % 500:04d}",
        "sortArtistName": f"{index % 300:04d}", "sortAlbumArtistName": f"{index % 120:04d}",
        "libraryName": "テストライブラリ", "path": f"Music/{index:05d}/track.mp3",
        "libraryPath": "/private/library", "hasCoverArt": True, "coverArtPath": "hidden",
        "bookmarkPosition": 0, "orderTitle": f"{index:06d}", "artistId": f"artist-{index % 300}",
    }


class FakeState:
    def __init__(self, song_count: int):
        self.lock = threading.RLock()
        self.songs = [synthetic_song(index) for index in range(song_count)]
        self.playlists = OrderedDict({
            "p1": {"id": "p1", "name": "テストプレイリスト", "ownerId": "u-test", "ownerName": "test", "tracks": []},
            "p2": {"id": "p2", "name": "スマートプレイリスト", "ownerId": "u-test", "ownerName": "test", "rules": {"all": []}, "tracks": []},
            "p3": {"id": "p3", "name": "他ユーザーのプレイリスト", "ownerId": "u-other", "ownerName": "other", "tracks": []},
        })
        self.next_playlist = 4

    def playlist_json(self, playlist):
        return {key: value for key, value in playlist.items() if key != "tracks"} | {"songCount": len(playlist["tracks"])}


def make_handler(state: FakeState):
    class Handler(BaseHTTPRequestHandler):
        server_version = "fake-navidrome/0.1"

        def log_message(self, *_args):
            return

        def json(self):
            length = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(length) or b"{}")

        def reply(self, status, payload, headers=None):
            raw = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            for key, value in (headers or {}).items(): self.send_header(key, value)
            self.end_headers(); self.wfile.write(raw)

        def authorized(self):
            return self.headers.get("X-Nd-Authorization") == "Bearer fake-token"

        def do_POST(self):
            path = urlsplit(self.path).path
            if path == "/auth/login":
                body = self.json()
                if body.get("username") == "test" and body.get("password") == "test": self.reply(200, {"token": "fake-token", "id": "u-test", "name": "test"})
                else: self.reply(401, {"error": "invalid credentials"})
                return
            if not self.authorized(): self.reply(401, {"error": "unauthorized"}); return
            if path == "/api/playlist":
                body = self.json(); name = str(body.get("name", "")).strip()
                with state.lock:
                    pid = f"p{state.next_playlist}"; state.next_playlist += 1
                    state.playlists[pid] = {"id": pid, "name": name, "ownerId": "u-test", "ownerName": "test", "tracks": []}
                    self.reply(200, state.playlist_json(state.playlists[pid]))
                return
            parts = [part for part in path.split("/") if part]
            if len(parts) == 4 and parts[:2] == ["api", "playlist"] and parts[3] == "tracks":
                with state.lock:
                    playlist = state.playlists.get(parts[2])
                    if not playlist: self.reply(404, {"error": "not found"}); return
                    ids = self.json().get("ids", [])
                    for song_id in ids: playlist["tracks"].append({"id": str(len(playlist["tracks"]) + 1), "mediaFileId": str(song_id)})
                    self.reply(200, {"added": len(ids)})
                return
            self.reply(404, {"error": "not found"})

        def do_GET(self):
            if not self.authorized(): self.reply(401, {"error": "unauthorized"}); return
            parsed = urlsplit(self.path); path = parsed.path; query = parse_qs(parsed.query)
            if path == "/api/song":
                start, end = int(query.get("_start", [0])[0]), int(query.get("_end", [1000])[0])
                songs = sorted(state.songs, key=lambda song: str(song.get(query.get("_sort", ["id"])[0], "")), reverse=query.get("_order", ["asc"])[0].lower() == "desc")
                self.reply(200, songs[start:end], {"X-Total-Count": str(len(songs))}); return
            if path == "/api/playlist":
                start, end = int(query.get("_start", [0])[0]), int(query.get("_end", [10000])[0])
                with state.lock: self.reply(200, [state.playlist_json(p) for p in list(state.playlists.values())[start:end]])
                return
            parts = [part for part in path.split("/") if part]
            if len(parts) == 4 and parts[:2] == ["api", "playlist"] and parts[3] == "tracks":
                with state.lock:
                    playlist = state.playlists.get(parts[2]); self.reply(200, list(playlist["tracks"]) if playlist else [])
                return
            self.reply(404, {"error": "not found"})

        def do_DELETE(self):
            if not self.authorized(): self.reply(401, {"error": "unauthorized"}); return
            parts = [part for part in urlsplit(self.path).path.split("/") if part]
            with state.lock:
                if len(parts) == 3 and parts[:2] == ["api", "playlist"]:
                    if state.playlists.pop(parts[2], None) is None: self.reply(404, {"error": "not found"})
                    else: self.reply(200, {})
                    return
                if len(parts) == 4 and parts[:2] == ["api", "playlist"] and parts[3] == "tracks":
                    playlist = state.playlists.get(parts[2]); positions = [int(value) for value in parse_qs(urlsplit(self.path).query).get("id", [])]
                    if not playlist: self.reply(404, {"error": "not found"}); return
                    removed = []
                    for position in sorted(set(positions), reverse=True):
                        if 1 <= position <= len(playlist["tracks"]): removed.append(playlist["tracks"].pop(position - 1)["mediaFileId"])
                    for index, track in enumerate(playlist["tracks"], 1): track["id"] = str(index)
                    self.reply(200, {"ids": removed}); return
            self.reply(404, {"error": "not found"})

    return Handler


def make_server(song_count: int = 10000, port: int = 0):
    state = FakeState(song_count)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    server.fake_state = state
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="Navidrome API test server")
    parser.add_argument("--songs", type=int, default=10000)
    parser.add_argument("--port", type=int, default=4612)
    args = parser.parse_args(argv)
    server = make_server(args.songs, args.port)
    print(f"fake Navidrome listening on http://127.0.0.1:{server.server_port}", flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__ == "__main__": main()
