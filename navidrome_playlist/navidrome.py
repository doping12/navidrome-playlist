from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping


class NavidromeError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class NavidromeClient:
    """Small client for Navidrome's native API.

    ``transport`` is intentionally injectable so API behavior can be tested without
    a network server. It receives a Request and returns an HTTPResponse-like object.
    """

    def __init__(self, base_url: str, username: str, password: str, transport=None):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.token = ""
        self.user_id = ""
        self.user_name = ""
        self._transport = transport or urllib.request.urlopen
        self._lock = threading.RLock()

    def _url(self, path: str, params: Mapping[str, object] | None = None) -> str:
        url = f"{self.base_url}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        return url

    @staticmethod
    def _header(response, name: str) -> str | None:
        headers = getattr(response, "headers", {})
        if hasattr(headers, "get"):
            result = headers.get(name) or headers.get(name.lower()) or headers.get(name.upper())
            if result:
                return result
        if hasattr(headers, "items"):
            wanted = name.lower()
            for key, value in headers.items():
                if str(key).lower() == wanted:
                    return value
        return None

    @staticmethod
    def _read(response):
        body = response.read()
        if isinstance(body, bytes):
            body = body.decode("utf-8")
        return json.loads(body) if body else None

    def login(self) -> dict:
        if not self.username or not self.password:
            raise NavidromeError("Navidromeのユーザー名とパスワードを設定してください")
        request = urllib.request.Request(
            self._url("/auth/login"),
            data=json.dumps({"username": self.username, "password": self.password}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            response = self._transport(request)
            payload = self._read(response)
        except urllib.error.HTTPError as exc:
            raise NavidromeError("Navidromeへのログインに失敗しました", exc.code) from exc
        except (ValueError, UnicodeError) as exc:
            raise NavidromeError("Navidromeのログイン応答が不正です") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise NavidromeError(f"Navidromeに接続できません: {exc}") from exc
        if not isinstance(payload, dict) or not payload.get("token"):
            raise NavidromeError("Navidromeのログイン応答にトークンがありません")
        self.token = str(payload["token"])
        self.user_id = str(payload.get("id", ""))
        self.user_name = str(payload.get("name", self.username))
        return payload

    def request(self, method: str, path: str, *, params=None, body=None, retry=True):
        with self._lock:
            if not self.token:
                self.login()
            headers = {"x-nd-authorization": f"Bearer {self.token}"}
            data = None
            if body is not None:
                data = json.dumps(body).encode("utf-8")
                headers["Content-Type"] = "application/json"
            request = urllib.request.Request(self._url(path, params), data=data, headers=headers, method=method)
            try:
                response = self._transport(request)
                result = self._read(response)
            except urllib.error.HTTPError as exc:
                if exc.code == 401 and retry:
                    self.login()
                    return self.request(method, path, params=params, body=body, retry=False)
                detail = ""
                try:
                    error_body = exc.read().decode("utf-8")
                    parsed = json.loads(error_body)
                    detail = str(parsed.get("error", parsed.get("message", "")))
                except (ValueError, OSError):
                    pass
                raise NavidromeError(detail or f"Navidrome API error ({exc.code})", exc.code) from exc
            except (ValueError, UnicodeError) as exc:
                raise NavidromeError("Navidrome APIの応答が不正です") from exc
            except (urllib.error.URLError, OSError) as exc:
                raise NavidromeError(f"Navidrome APIに接続できません: {exc}") from exc
            refreshed = self._header(response, "X-Nd-Authorization")
            if refreshed:
                value = refreshed.removeprefix("Bearer ").strip()
                if value:
                    self.token = value
            return result, response

    def get(self, path, params=None):
        return self.request("GET", path, params=params)[0]

    def post(self, path, body=None, params=None):
        return self.request("POST", path, params=params, body=body)[0]

    def delete(self, path, params=None):
        return self.request("DELETE", path, params=params)[0]

    def all_songs(self, page_size: int = 1000) -> list[dict]:
        songs = []
        seen_ids: set[str] = set()
        start = 0
        while True:
            # A unique server-side sort key keeps page boundaries stable while the
            # library is being read.  The id check below is defensive for servers
            # that still return an overlapping page.
            result, response = self.request("GET", "/api/song", params={"_start": start, "_end": start + page_size, "_sort": "id", "_order": "asc"})
            if not isinstance(result, list):
                raise NavidromeError("曲一覧の形式が不正です")
            for song in result:
                song_id = song.get("id") if isinstance(song, dict) else None
                if song_id is None or str(song_id) not in seen_ids:
                    songs.append(song)
                    if song_id is not None:
                        seen_ids.add(str(song_id))
            total_header = NavidromeClient._header(response, "X-Total-Count")
            total = int(total_header) if total_header and total_header.isdigit() else None
            if not result or (total is not None and start + len(result) >= total) or len(result) < page_size:
                return songs[:total] if total is not None else songs
            start += len(result)

    def playlists(self) -> list[dict]:
        result = self.get("/api/playlist", {"_start": 0, "_end": 10000})
        return result if isinstance(result, list) else []

    def playlist_tracks(self, playlist_id: str) -> list[dict]:
        result = self.get(f"/api/playlist/{urllib.parse.quote(str(playlist_id), safe='')}/tracks")
        return result if isinstance(result, list) else []

    def create_playlist(self, name: str, public: bool = False) -> str:
        result = self.post("/api/playlist", {"name": name, "public": public})
        if not isinstance(result, dict) or not result.get("id"):
            raise NavidromeError("プレイリスト作成の応答が不正です")
        return str(result["id"])

    def add_tracks(self, playlist_id: str, song_ids: list[str]) -> int:
        result = self.post(f"/api/playlist/{urllib.parse.quote(str(playlist_id), safe='')}/tracks", {"ids": song_ids})
        return int(result.get("added", len(song_ids))) if isinstance(result, dict) else len(song_ids)

    def remove_track_positions(self, playlist_id: str, positions: list[str], chunk_size: int = 200):
        removed = 0
        encoded_id = urllib.parse.quote(str(playlist_id), safe="")
        for start in range(0, len(positions), chunk_size):
            chunk = positions[start:start + chunk_size]
            result = self.delete(f"/api/playlist/{encoded_id}/tracks", [("id", p) for p in chunk])
            removed += len(result.get("ids", chunk)) if isinstance(result, dict) else len(chunk)
        return removed
