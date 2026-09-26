from __future__ import annotations

import argparse
import sys

from .config import load_config
from .library import Library
from .navidrome import NavidromeClient, NavidromeError
from .server import serve


def main(argv=None):
    parser = argparse.ArgumentParser(description="Navidromeのプレイリストを一括編集するローカルWeb UI")
    parser.add_argument("--config", default="config.toml", help="設定ファイルのパス")
    args = parser.parse_args(argv)
    try:
        settings = load_config(args.config)
        if not settings.username or not settings.password:
            parser.error("username/passwordをconfig.tomlまたはNDPL_USER/NDPL_PASSWORDで設定してください")
        client = NavidromeClient(settings.url, settings.username, settings.password)
        library = Library(client)
        serve(library, settings.host, settings.port)
    except (NavidromeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"サーバーを起動できません: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
