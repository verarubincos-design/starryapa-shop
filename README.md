# StarryApa みんなで歩けるお店（Render用パッケージ）

Museスペース版「StarryApa みんなで歩ける試作」と同じお店を、Renderで公開するための一式です。

## 中身

- `server.js` — 小さなサーバー（アカウント・位置同期・チャット）。ライブラリ不要、Node.jsだけで動きます
- `public/index.html` — お店のページ本体
- `public/assets/` — 部屋（StarryApa）と人形3種（ベラ／女の子／男の子）の3Dモデル
- `render.yaml` — Renderの自動設定ファイル
- `package.json`

## できること（スペース版と同じ）

- アカウント登録・ログイン（ID＋パスワード、パスワードは4文字以上ならOK）
- アバター3種（ベラ／女の子／男の子）×色5種、名前はアカウントから自動で付きます
- 歩行（PC: WASD＋マウス / スマホ: スティック＋ドラッグ）、人数表示、入室ピンポン
- 全体チャット（ログ・吹き出し・チャットログのテキスト保存）
- ログインID「vera」は店主アカウント（名前の横に金の「店主」タグ）

## Renderへの置き方

### 1. GitHubに置く

1. https://github.com でアカウントを作る（まだの場合）
2. 右上の「＋」→「New repository」で、新しいリポジトリを作る（名前は例：`starryapa-shop`、Public）
3. 作ったリポジトリの画面で「uploading an existing file」を押す
4. このフォルダの**中身全部**（server.js、public フォルダ、render.yaml、package.json、README.md）をドラッグ＆ドロップして「Commit changes」

### 2. Renderで公開する

1. Renderのダッシュボードで「New」→「Blueprint」を選ぶ
2. さっき作ったGitHubリポジトリを接続する（初回はGitHubとの連携許可が出ます）
3. render.yaml が自動で読まれるので、そのまま「Apply」／「Create」
4. 数分待つと `https://starryapa-shop-xxxx.onrender.com` のような住所が発行されます。これがお店のURLです

※ Blueprint が分かりにくい場合は「New」→「Web Service」→ リポジトリ選択でもOK。その時は Build Command に `npm install`、Start Command に `node server.js`、Instance Type は Free を選んでください。

## 注意（試験運用の割り切り）

- **無料プランは眠ります**：15分くらい誰もアクセスしないとサービスがスリープし、次の人が開いた時に起きるまで30秒〜1分かかります
- **アカウントは消えることがあります**：無料プランではサーバーの再起動・再デプロイで保存データ（data.json）が初期化されます。本格運用する時は有料プラン＋データベースを検討してください
- パスワードはハッシュ化して保存しています（平文では保存しません）

## ローカルで試す場合

Node.js があれば `node server.js` で起動し、http://localhost:3000 で開けます。
