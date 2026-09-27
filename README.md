# navidrome-playlist

Navidromeの曲とプレイリストを、ブラウザ上でまとめて編集するための軽量なローカルWeb UIです。再生機能はありません。曲をクリック／ドラッグで複数選択し、既存プレイリストへの追加、新規作成、プレイリストからの一括削除を行えます。

## セットアップ

Python 3.12以上とuvを用意し、プロジェクトのルートで実行します。

```sh
uv sync
cp config.example.toml config.toml
```

`config.toml` の `navidrome.username` と `navidrome.password` を設定してください。URLは通常 `http://localhost:4533` です。設定値は `NDPL_URL`、`NDPL_USER`、`NDPL_PASSWORD`、`NDPL_HOST`、`NDPL_PORT` 環境変数でも上書きできます。

## 起動と使い方

```sh
uv run navidrome-playlist
# または uv run navidrome-playlist --config /path/to/config.toml
```

既定では `http://127.0.0.1:4534` で待ち受けます。表の行は通常クリックで個別に選択でき、Shift+クリックは既存の選択に範囲を追加します。行をドラッグすると選択／選択解除を塗りつぶせます。Ctrl/Cmd+A、表示中を全選択、選択解除、表示中を反転も利用できます。フィルターで非表示になった選択曲もプレイリスト操作の対象です。

列見出しのクリックで昇順・降順・解除を切り替えられ、複数列に設定したソートは表示列の左から順に優先されます。「ソート解除」で全て解除できます。見出しのドラッグで列順、列境界のドラッグで幅を変更でき、表示列ボタンで列の表示を切り替えられます。見出しのフィルターボタンでは複数条件を設定できます。これらの設定はブラウザのlocalStorageに保存されます（保存できない環境でも動作します）。
プレイリスト操作後に選択を解除したい場合は、ツールバーの「操作後に選択を解除」をオンにしてください。この設定もブラウザのlocalStorageに保存されます。

## 開発・テスト

```sh
uv run pytest -q
node --test tests/
node --check navidrome_playlist/static/app.js
node --check navidrome_playlist/static/logic.js
uv run python -m compileall -q navidrome_playlist tests
node tests/performance.mjs
uv run python tests/payload_size.py
```

ブラウザやAPIの開発確認には、依存関係のないフェイクNavidromeも使えます。既定で10,000曲を生成し、`--songs` と `--port` で変更できます。

```sh
uv run python tests/fake_navidrome.py --songs 10000 --port 4612
```

フェイクサーバーを使ったAPIのエンドツーエンドテストは `uv run pytest -q` に含まれています。

NavidromeのネイティブREST APIに依存しています。Navidrome 0.64.0で検証しています。プレイリストの所有者でない場合やスマートプレイリストは編集できず、読み取り専用で表示されます。API仕様に依存するため、インターネットへ公開せずlocalhostにバインドして使ってください。認証情報やトークンはログに出力しません。
