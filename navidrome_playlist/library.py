from __future__ import annotations

import concurrent.futures
import math
import threading
from collections import Counter

from .navidrome import NavidromeClient

EXCLUDED_KEYS = {"lyrics", "bookmarkPosition", "libraryPath"}
ID_KEYS = {"id"}
DATE_KEYS = {"date", "originalDate", "releaseDate", "createdAt", "updatedAt", "birthTime"}
NUMBER_KEYS = {"trackNumber", "discNumber", "year", "originalYear", "releaseYear", "size", "duration", "bitRate", "sampleRate", "bitDepth", "channels", "bpm"}
LABEL_OVERRIDES = {
    "title": "タイトル", "album": "アルバム", "artist": "楽曲アーティスト", "albumArtist": "アルバムアーティスト",
    "releaseDate": "リリース日", "trackNumber": "トラック番号", "discNumber": "ディスク番号", "genre": "ジャンル",
    "duration": "長さ", "bitRate": "ビットレート", "sampleRate": "サンプルレート", "bitDepth": "ビット深度",
    "channels": "チャンネル", "year": "年", "originalYear": "元の年", "releaseYear": "リリース年",
    "date": "日付", "originalDate": "元の日付", "path": "パス", "suffix": "形式", "size": "サイズ",
    "compilation": "コンピレーション", "createdAt": "追加日時", "updatedAt": "更新日時",
    "catalogNum": "カタログ番号", "sortTitle": "ソート用タイトル", "sortAlbumName": "ソート用アルバム名",
    "sortArtistName": "ソート用アーティスト名", "sortAlbumArtistName": "ソート用アルバムアーティスト名",
    "libraryName": "ライブラリ", "comment": "コメント", "bitDepth": "ビット深度", "bpm": "BPM",
}


def _is_internal_key(key: str) -> bool:
    lower = key.lower()
    if lower.startswith("mbz"):
        return False
    return (
        lower in {"hascoverart", "coverart", "coverartpath"}
        or "coverart" in lower
        or lower.endswith("id")
        or lower.startswith("order")
    )


def _date_fallback(song: dict) -> str:
    for key in ("releaseDate", "date", "originalDate"):
        value = song.get(key)
        if value not in (None, ""):
            return str(value)
    return str(song.get("year", "") or song.get("originalYear", "") or "")


def _stringify(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return "; ".join(_stringify(item) for item in value)
    if isinstance(value, dict):
        return "; ".join(f"{key}: {_stringify(item)}" for key, item in value.items())
    return str(value)


def normalize_song(song: dict) -> dict[str, object]:
    """Flatten a Navidrome song while retaining useful display/filter fields."""
    values: dict[str, object] = {}
    for key, value in song.items():
        if key in EXCLUDED_KEYS or key in ID_KEYS or key in {"genres", "tags", "participants", "missing"} or _is_internal_key(key):
            continue
        if isinstance(value, (dict, list)):
            continue
        values[key] = value if value is not None else ""
    values["releaseDate"] = _date_fallback(song)
    genres = song.get("genres")
    if genres:
        values["genre"] = "; ".join(_stringify(g.get("name", g) if isinstance(g, dict) else g) for g in genres)
    tags = song.get("tags") or {}
    if isinstance(tags, dict):
        for name, tag_values in tags.items():
            values[f"tag:{name}"] = _stringify(tag_values)
    participants = song.get("participants") or {}
    if isinstance(participants, dict):
        for role, people in participants.items():
            if role.lower() not in {"artist", "albumartist"}:
                values[f"role:{role}"] = "; ".join(_stringify(p.get("name", p) if isinstance(p, dict) else p) for p in people)
    return values


def field_type(key: str, values: list[object]) -> str:
    if key in DATE_KEYS or key in {"releaseDate"}:
        return "date"
    if key in NUMBER_KEYS:
        return "number"
    non_empty = [value for value in values if value not in (None, "")]
    if non_empty and all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in non_empty):
        return "number"
    return "text"


def label_for(key: str) -> str:
    if key in LABEL_OVERRIDES:
        return LABEL_OVERRIDES[key]
    if key.startswith("tag:"):
        return f"タグ: {key[4:]}"
    if key.startswith("role:"):
        return f"役割: {key[5:]}"
    return key


class Library:
    def __init__(self, client: NavidromeClient):
        self.client = client
        self.lock = threading.RLock()
        self.songs: list[dict[str, object]] = []
        self.song_ids: set[str] = set()
        self.playlists: list[dict] = []
        self.membership: dict[str, Counter[str]] = {}
        self.fields: list[dict[str, str]] = []
        self.reload()

    def reload(self):
        songs = []
        seen_ids: set[str] = set()
        for song in self.client.all_songs():
            if song.get("missing") or song.get("id") is None:
                continue
            song_id = str(song["id"])
            if song_id in seen_ids:
                continue
            seen_ids.add(song_id)
            songs.append(normalize_song(song) | {"id": song_id})
        playlists = self.client.playlists()
        def get_tracks(playlist):
            return playlist, self.client.playlist_tracks(str(playlist["id"]))
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, max(1, len(playlists)))) as pool:
            tracks = list(pool.map(get_tracks, playlists))
        membership = {str(p["id"]): Counter(str(track.get("mediaFileId")) for track in entries if track.get("mediaFileId") is not None) for p, entries in tracks}
        with self.lock:
            self.songs = songs
            self.song_ids = {str(song["id"]) for song in songs}
            self.playlists = playlists
            self.membership = membership
            keys: list[str] = []
            for song in songs:
                for key in song:
                    if key != "id" and key not in keys:
                        keys.append(key)
            self.fields = [{"key": key, "label": label_for(key), "type": field_type(key, [song.get(key) for song in songs])} for key in keys]
        return self.payload()

    def _playlist_info(self, playlist: dict) -> dict:
        owner_id = str(playlist.get("ownerId", ""))
        editable = bool(owner_id and owner_id == self.client.user_id and not playlist.get("rules"))
        return {"id": str(playlist.get("id", "")), "name": str(playlist.get("name", "")), "owner": str(playlist.get("ownerName", "")), "editable": editable, "smart": bool(playlist.get("rules")), "songCount": int(playlist.get("songCount", 0) or 0)}

    def payload(self) -> dict:
        with self.lock:
            fields = [{"key": "id", "label": "ID", "type": "text"}, *self.fields]
            songs = [[song.get(field["key"], "") for field in fields] for song in self.songs]
            membership = {pid: {song_id: count for song_id, count in counts.items() if count} for pid, counts in self.membership.items()}
            return {"fields": fields, "songs": songs, "playlists": [self._playlist_info(p) for p in self.playlists], "membership": membership}

    def _check_ids(self, song_ids) -> list[str]:
        if not isinstance(song_ids, list) or any(not isinstance(item, (str, int)) or isinstance(item, bool) for item in song_ids):
            raise ValueError("songIds must be an array of IDs")
        ids = [str(item) for item in song_ids]
        unknown = set(ids) - self.song_ids
        if unknown:
            raise ValueError("unknown song id: " + ", ".join(sorted(unknown)))
        return list(dict.fromkeys(ids))

    def _editable(self, playlist_id: str) -> dict:
        for playlist in self.playlists:
            if str(playlist.get("id")) == str(playlist_id):
                info = self._playlist_info(playlist)
                if not info["editable"]:
                    raise PermissionError("このプレイリストは編集できません")
                return playlist
        raise ValueError("unknown playlist id")

    def add(self, playlist_id: str, song_ids) -> dict:
        ids = self._check_ids(song_ids)
        self._editable(playlist_id)
        current = self.client.playlist_tracks(playlist_id)
        existing = {str(item.get("mediaFileId")) for item in current}
        to_add = [song_id for song_id in ids if song_id not in existing]
        added = self.client.add_tracks(playlist_id, to_add) if to_add else 0
        with self.lock:
            self.membership[str(playlist_id)] = Counter(str(item.get("mediaFileId")) for item in current)
            for song_id in to_add:
                self.membership[str(playlist_id)][song_id] += 1
            membership = dict(self.membership[str(playlist_id)])
        return {"added": added, "skipped": len(ids) - len(to_add), "membership": membership}

    def remove(self, playlist_id: str, song_ids) -> dict:
        ids = self._check_ids(song_ids)
        self._editable(playlist_id)
        current = self.client.playlist_tracks(playlist_id)
        target_ids = set(ids)
        positions: list[tuple[int, str]] = []
        for index, item in enumerate(current):
            if str(item.get("mediaFileId")) not in target_ids:
                continue
            position = item.get("id")
            if position is None:
                position = index + 1
            positions.append((int(position), str(position)))
        positions.sort(key=lambda item: item[0], reverse=True)
        position_values = [position for _, position in positions]
        removed = self.client.remove_track_positions(playlist_id, position_values) if position_values else 0
        with self.lock:
            self.membership[str(playlist_id)] = Counter(str(item.get("mediaFileId")) for item in current if str(item.get("mediaFileId")) not in target_ids)
            membership = dict(self.membership[str(playlist_id)])
        return {"removed": removed, "membership": membership}

    def create(self, name, song_ids) -> dict:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("name must be a non-empty string")
        ids = self._check_ids(song_ids)
        playlist_id = self.client.create_playlist(name.strip())
        if ids:
            self.client.add_tracks(playlist_id, ids)
        new_tracks = self.client.playlist_tracks(playlist_id)
        new_membership = Counter(str(track.get("mediaFileId")) for track in new_tracks if track.get("mediaFileId") is not None)
        if not new_membership and ids:
            new_membership = Counter(ids)
        fresh_playlists = self.client.playlists()
        with self.lock:
            if any(str(p.get("id")) == playlist_id for p in fresh_playlists):
                self.playlists = fresh_playlists
            self.membership[playlist_id] = new_membership
            info = next((self._playlist_info(p) for p in self.playlists if str(p.get("id")) == playlist_id), {"id": playlist_id, "name": name.strip(), "editable": True, "smart": False, "owner": "", "songCount": len(ids)})
        return {"id": playlist_id, "playlist": info, "membership": dict(self.membership.get(playlist_id, {}))}
