from __future__ import annotations

import json
import os
import urllib.error
from types import SimpleNamespace

import pytest

from navidrome_playlist.config import load_config
from navidrome_playlist.library import Library, field_type, normalize_song
from navidrome_playlist.navidrome import NavidromeClient
from navidrome_playlist.server import App, ApiFailure


class Response:
    def __init__(self, value, headers=None):
        self.value = value
        self.headers = headers or {}

    def read(self):
        return json.dumps(self.value).encode()


def test_client_login_refresh_and_401_retry():
    calls = []

    def transport(request):
        calls.append(request)
        if request.full_url.endswith("/auth/login"):
            token = "first" if len([r for r in calls if r.full_url.endswith("/auth/login")]) == 1 else "second"
            return Response({"token": token, "id": "u1", "name": "User"})
        if len(calls) == 2:
            raise urllib.error.HTTPError(request.full_url, 401, "expired", {}, None)
        assert request.headers["X-nd-authorization"] == "Bearer second"
        return Response([{"id": "s1"}], {"X-Nd-Authorization": "Bearer refreshed"})

    client = NavidromeClient("http://example", "u", "p", transport)
    result = client.get("/api/song")
    assert result == [{"id": "s1"}]
    assert len([r for r in calls if r.full_url.endswith("/auth/login")]) == 2
    assert client.token == "refreshed"


def test_delete_positions_are_chunked_in_descending_order():
    client = object.__new__(NavidromeClient)
    calls = []
    client.delete = lambda path, params=None: calls.append((path, params)) or {"ids": [value for _, value in params]}
    removed = client.remove_track_positions("p", [str(i) for i in range(450, 0, -1)])
    assert removed == 450
    assert [len(params) for _, params in calls] == [200, 200, 50]
    assert calls[0][1][0] == ("id", "450") and calls[0][1][-1] == ("id", "251")
    assert calls[1][1][0] == ("id", "250") and calls[-1][1][-1] == ("id", "1")


def test_song_paging_and_normalization():
    pages = [
        Response([{"id": "1", "title": "A", "date": "2015", "missing": False, "lyrics": "secret", "artistId": "a", "genres": [{"name": "Rock"}], "tags": {"recordlabel": ["Label"]}, "participants": {"composer": [{"name": "C"}], "artist": [{"name": "A"}]}}, {"id": "missing", "missing": True}], {"X-Total-Count": "3"}),
        Response([{"id": "2", "title": "B", "releaseDate": "2015-07-23", "date": "2015", "missing": False}], {"X-Total-Count": "3"}),
    ]
    class Client:
        def __init__(self): self.i = 0
        def request(self, method, path, params=None):
            value = pages[self.i]; self.i += 1; return value.value, value
    client = Client()
    songs = NavidromeClient.all_songs(client, page_size=2)
    assert [s["id"] for s in songs] == ["1", "missing", "2"]
    normalized = normalize_song(songs[0])
    assert normalized["releaseDate"] == "2015"
    assert normalized["genre"] == "Rock"
    assert normalized["tag:recordlabel"] == "Label"
    assert normalized["role:composer"] == "C"
    assert "lyrics" not in normalized and "artistId" not in normalized
    assert field_type("rgTrackGain", ["", -3.2, -1.0]) == "number"
    assert field_type("rgAlbumPeak", [0.9, 1.0]) == "number"
    assert field_type("flag", [True, False]) == "text"
    assert "mbzRecordingId" in normalize_song({"mbzRecordingId": "mbz-1", "mediaFileId": "internal"})
    hidden = normalize_song({"bookmarkPosition": 10, "hasCoverArt": True, "orderTitle": "x", "libraryPath": "x"})
    assert set(hidden) == {"releaseDate"}


class FakeClient:
    user_id = "owner"

    def __init__(self):
        self.tracks = {"editable": [{"mediaFileId": "1"}, {"mediaFileId": "1"}, {"mediaFileId": "2"}, {"mediaFileId": "3"}]}
        self.added = []
        self.deleted = []

    def all_songs(self):
        return [{"id": "1", "title": "One"}, {"id": "2", "title": "Two"}, {"id": "3", "title": "Three"}]
    def playlists(self):
        return [{"id": "editable", "name": "Mine", "ownerId": "owner", "ownerName": "Me", "songCount": 4}, {"id": "smart", "name": "Smart", "ownerId": "owner", "rules": {"all": []}}, {"id": "foreign", "name": "Other", "ownerId": "other"}]
    def playlist_tracks(self, pid): return list(self.tracks.get(str(pid), []))
    def add_tracks(self, pid, ids): self.added.extend(ids); return len(ids)
    def remove_track_positions(self, pid, positions): self.deleted.extend(positions); return len(positions)
    def create_playlist(self, name): return "created"


def test_membership_permissions_add_remove_and_create():
    fake = FakeClient(); library = Library(fake)
    assert library.membership["editable"]["1"] == 2
    assert library._playlist_info(fake.playlists()[1])["smart"]
    assert not library._playlist_info(fake.playlists()[1])["editable"]
    assert not library._playlist_info(fake.playlists()[2])["editable"]
    result = library.add("editable", ["1", "2", "3"])
    assert result["added"] == 0 + 0  # existing 1/2/3 are all skipped
    assert result["skipped"] == 3
    fake.tracks["editable"] = [{"mediaFileId": "1"}] * 205 + [{"mediaFileId": "2"}]
    result = library.remove("editable", ["1"])
    assert result["removed"] == 205
    assert fake.deleted == [str(i) for i in range(205, 0, -1)]
    with pytest.raises(PermissionError): library.add("smart", ["1"])
    with pytest.raises(PermissionError): library.remove("foreign", ["1"])
    assert library.create("New", ["1"])["id"] == "created"


def test_config_env_overrides(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    path.write_text('[navidrome]\nurl="http://config"\nusername="config-user"\npassword="config-pass"\n[server]\nhost="0.0.0.0"\nport=4000\n')
    monkeypatch.setenv("NDPL_URL", "http://env")
    monkeypatch.setenv("NDPL_USER", "env-user")
    monkeypatch.setenv("NDPL_PASSWORD", "env-pass")
    monkeypatch.setenv("NDPL_HOST", "127.0.0.1")
    monkeypatch.setenv("NDPL_PORT", "4500")
    settings = load_config(path)
    assert settings == settings.__class__("http://env", "env-user", "env-pass", "127.0.0.1", 4500)


def test_server_rejects_noneditable_and_content_type():
    class Handler:
        headers = {"Content-Type": "text/plain"}
    fake = FakeClient(); app = App(Library(fake))
    with pytest.raises(ApiFailure) as error:
        app.api(Handler(), "POST", "/api/playlists/smart/add")
    assert error.value.status == 415

    class JsonHandler:
        headers = {"Content-Type": "application/json", "Content-Length": "17"}
        class Body:
            def read(self, n): return b'{"songIds":["1"]}'
        rfile = Body()
    with pytest.raises(ApiFailure) as error:
        app.api(JsonHandler(), "POST", "/api/playlists/smart/add")
    assert error.value.status == 403
