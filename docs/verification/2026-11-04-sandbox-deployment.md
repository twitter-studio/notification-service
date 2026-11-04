# sandbox 検証用の初期配置

2026-11-04、オーナーが運営 API・D1・再送 Queue の作成、初期 migration、sandbox 専用 APNs 鍵の Cloudflare secret への保存、招待制での実機検証と構成の保持を承認した。今回の初期配置も、保護した GitHub Environment を経由しない CLI 実行の例外として承認された。production の APNs 鍵と X 接続は対象外。

## 配置した構成

- Cloudflare account: `1657a0cfdeed30e3504b6f86cd9575e8`。
- Worker: `notification-service`。
- origin: `https://notification-service.zunda-dev.workers.dev`。
- APNS-002 の実装: `518055fa05780c11ebf57d33e10061f0803c5910`。
- secret 配置後の稼働 version: `b378de42-43f8-476d-b8f1-5ca1a6543191` (100%)。
- D1: `notification-service`、`b19c69b6-066d-4cf0-a0c0-8274ae6f2d3d`、APAC。
- Queue: `notification-apns-retries`、`fd5c2ef1cbe94723a1715b0841e0fb51`。保存86400秒、producer / consumer はこの Worker。
- Cron: `17,27,37,47 18 * * *` (UTC)。掃除の4回を1つの式にまとめる。
- APNs: Sandbox・Topic Specific・`com.twitter-studio.Tweetbot` のみ。

Wrangler の既存の OAuth 範囲に `queues:write` を追加し、オーナーがブラウザで認可した。OAuth 資格情報は Keychain の鍵で暗号化して保存する設定を継続している。

## 秘密

Worker に置いた secret の名前は次の5つ。値は出力もコミットもしない。

- `DEVICE_TOKEN_KEYS`
- `DEVICE_TOKEN_FINGERPRINT_KEY`
- `CHALLENGE_SIGNING_KEY`
- `ENROLLMENT_INVITE_CODE`
- `APNS_PROVIDER_KEYS`

暗号化、指紋、チャレンジにはそれぞれ独立した32バイトの乱数を使った。招待コードも32バイトの乱数。鍵の確認値は既存の `apps/api/scripts/key-check.mjs` と比較してから設定し、確認値だけを vars に置く。バックアップと `.p8` は Git 管理外の0700ディレクトリ・0600ファイルで Mac に保管する。Mac の秘密ファイルをソースや手順書へコピーしない。

## 費用の確認

配置前の画面で、既存の契約が Workers Paid ($5/月 + 従量) であることを確認した。契約は変更していない。Workers の使用量は約6,590件 / 含まれる月間1,000万件、CPU は約56,600ms / 月間3,000万ms、従量課金は $0.00 の表示だった。

D1 と Queue は作成前の一覧に既存のものがなかった。2026-11-04 の公式資料で、Paid に含まれる D1 の最初の100,000 DB、読み取り250億行/月、書き込み5,000万行/月、保存5GBと、Queue の最初の10,000個・100万operations/月の枠を確認した。今回の初期作成と少数の検証はこの含まれる枠で行う。継続的な費用や無料プランでの収まりを保証する結果ではない。招待数、異常時の再送、CPU と D1 の運用上限は QA-001 で検証する。

## 実行と確認

Wrangler 4.156.0 を、mise の固定 Node.js / pnpm で実行した。

1. D1 と Queue を作成した。Queue の保存期間を明示して86400秒にした。
2. `wrangler d1 migrations apply notification-service --remote` で `0000_init.sql` を適用した。25コマンド成功。
3. `PRAGMA foreign_key_check` は違反0件。
4. 配置設定は、独立したコードレビューとセキュリティレビューが指摘なし。
5. `pnpm lint`、`pnpm typecheck`、Workers 258件 + CLI 5件のテスト、API / probe の dry-run が成功。
6. `wrangler deploy` で Worker を配置し、`wrangler secret bulk` で5つの secret を設定した。
7. Cloudflare API で secret の名前、稼働 version、Queue の保存期間・consumer と observability を確認した。invocation logs は無効、traces も無効。
8. `curl https://notification-service.zunda-dev.workers.dev/health` が `200`、`{"status":"ok"}` を返した。

Python urllib の既定 User-Agent での health 確認は、Worker 到達前の Cloudflare 1010 になった。設定変更やブラウザへの偽装はせず、通常の curl で確認した。iOS と利用者の Worker の通信は別に実測する。

APNS-001 の一時 probe Worker は削除済み。ここに記録した運営 API は、オーナーが承認した検証用構成として保持する。他の Worker は変更していない。

## iOS の登録と所有確認

同日、iPhone 16 の自動署名ビルドで招待登録と端末登録が成功した。当初は未確認のままで、Workers Logs の既存のエラーは `apns_transport_or_signing_failed` だった。秘密の値や送信先 URL は出力しなかった。

クラスに保存した Workers の `fetch` の呼び出し元が globalThis でない問題を、通信関数を置き換えない workerd のテストで再現した。[PR #29](https://github.com/twitter-studio/notification-service/pull/29) (049bc39) で修正した。独立したコード／セキュリティレビューと GitHub Codex レビューは指摘なし、CI・lint・型チェック・Workers 259件と CLI 5件のテスト・dry-run が成功した。

修正後の main を、承認済みの sandbox 検証の範囲で配置した。稼働 version は `6f3c3660-e3bd-4139-aa0c-50a549dffdc1`、health は200。招待コードや APNs 鍵、権限、リソースは追加していない。

[Tweetbot PR #393](https://github.com/twitter-studio/tweetbot/pull/393) (084cf22) で `verification_sent: false` と送信後の待機を区別した。自動署名の実機／Simulator ビルドと665件のテストが成功、独立したコード／セキュリティレビューと GitHub Codex レビューは指摘なし。実機で未送信の日本語表示を確認できた。

反映後に実機から登録を1回再試行した。所有確認用の background push を iPhone が受信し、確認コードを API に返した。D1 の集計は確認済みの端末1台、実機の配信状態は「オン」、未送信・待機・失敗の表示は消えた。コード、トークン、資格情報を取り出して代わりに検証する方法は使っていない。

この結果は運営アダプターと iOS の所有確認 callback の実環境での往復を示す。通常の alert 通知の表示・タップと、Queue を使う実環境の再送を確認した結果ではない。

## 設定 API と通常の通知

[service PR #31](https://github.com/twitter-studio/notification-service/pull/31) (b97e51680afb70b8eddb68575e774a6adf7a5646) で設定取得・削除・テスト通知の3入口と ADR-0012 を追加した。マージ後の main を、承認済みの sandbox 検証として配置した。稼働 version は `c199c2fa-69d9-494e-88df-150fdcee67bb`。配置直前に Queue metrics の backlog_count と backlog_bytes が0であることを確認し、旧形式の仕事を残さず更新した。health は200、新しい3入口は未認証の要求に401を返した。

[Tweetbot PR #394](https://github.com/twitter-studio/tweetbot/pull/394) (4973bdd343d9d395d9ff5aa17e513cf43b312324) でクライアントを再生成し、設定取得・削除・テスト通知、前面での通知表示と、OS が読む英語・日本語の通知文を接続した。自動署名の実機／Simulator ビルド、iOS 670件、Workers 271件と CLI 5件のテストが成功した。独立したコード／セキュリティレビューと GitHub Codex レビューを受け、指摘を修正した。旧 Queue 形式の読み替えを足さない判断と配置条件は ADR-0012 に記録した。

実機で日本語・英語の設定画面と配信「オン」を確認した。停止・再有効化でも、実機表示と D1 の状態が一致した。実機のテスト通知ボタンから1回送信し、画面の sent 応答と日次枠の集計1件を確認した。その後、オーナーが iPhone 16 で通常の通知が表示されたことを確認した。これは独立 probe ではなく、運営 API と本アダプターを通した結果。

許可拒否、トークンの更新、再インストール、アカウント削除後の状態は自動テストで確認した。実機の通知アカウントは保持し、削除操作は行っていない。IOS-001 の受け入れ条件を満たし、Tweetbot #366 と service #24 は完了。通知タップの安全な移動と不正 ID は IOS-002 (Tweetbot #367) に残る。

## 実 Queue consumer の経路確認

コードレビューとセキュリティレビューを受けた一時スクリプトで、空の `notification-apns-retries` に60秒遅延の通知を1件だけ投入した。Cloudflare の既存の承認済み CLI 認証を使い、sandbox・指定 topic・有効かつ確認済みの端末が1台だけであることを確認してから実行した。

D1 から読んだのはアカウント・インストール・端末の ID、指紋、環境、topic のみ。平文トークン、暗号文、セッション、署名鍵は取得していない。ジョブは通常の consumer の形式と、固定の test 通知の payload を使う。秘密や指紋の値をログやローカルファイルに出力・保存していない。投入前の backlog_count と backlog_bytes は0、API は成功を返し、返却された metadata の backlog_bytes は559だった。metrics は best-effort のため、直後の backlog_count の0だけで処理済みとはみなさない。

これは管理 API からの1件の経路確認で、アプリ API の回数制限・日次枠は通していない。consumer は通常どおり、D1 でインストールと端末の権限を再確認する。初回の APNs 障害による Queue 投入や指数バックオフを実環境で再現した結果ではない。その後、Queue metrics の backlog_count と backlog_bytes が0に戻り、オーナーが通常テストとは別の追加通知の表示を iPhone 16 で確認した。これにより、実 consumer での D1 読み直し・復号・APNs 送信から実機表示までの経路を確認できた。

## 残るゲート

APNS-002 の JWT・応答分類・上限付き再送の自動テストと、通常の通知および実 Queue consumer 経由の sandbox 到達を確認し、Issue #8 の受け入れ条件を満たした。実環境で初回 APNs を429/5xxにして自動で Queue に入り、再試行・打ち切りまで進む試験はしていない。障害時の実環境試験、負荷・費用・ログとアラートの確認は QA-001 (service #9) に残す。通常の HTTP 200 と実機表示だけから、障害後の再送まで成功したとはみなさない。通知タップは Tweetbot #367 で追跡する。

## 根拠

- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare 1010 と workers.dev の制約](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
