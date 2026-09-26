from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    url: str = "http://localhost:4533"
    username: str = ""
    password: str = ""
    host: str = "127.0.0.1"
    port: int = 4534


def load_config(path: str | Path = "config.toml") -> Settings:
    """Load TOML settings and apply the documented environment overrides."""
    values: dict = {}
    config_path = Path(path)
    if config_path.exists():
        with config_path.open("rb") as file:
            values = tomllib.load(file)
    nd = values.get("navidrome", {})
    server = values.get("server", {})
    if not isinstance(nd, dict) or not isinstance(server, dict):
        raise ValueError("config.toml の [navidrome] と [server] はテーブルで指定してください")

    def env(name: str, current, converter=str):
        value = os.environ.get(name)
        return converter(value) if value is not None else current

    try:
        port = env("NDPL_PORT", server.get("port", 4534), int)
    except (TypeError, ValueError) as exc:
        raise ValueError("ポート番号は整数で指定してください") from exc
    if not 1 <= port <= 65535:
        raise ValueError("ポート番号は1から65535の範囲で指定してください")
    return Settings(
        url=env("NDPL_URL", nd.get("url", "http://localhost:4533")),
        username=env("NDPL_USER", nd.get("username", "")),
        password=env("NDPL_PASSWORD", nd.get("password", "")),
        host=env("NDPL_HOST", server.get("host", "127.0.0.1")),
        port=port,
    )
