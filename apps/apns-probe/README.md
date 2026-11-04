# APNs sandbox の到達確認 (APNS-001)

Cloudflare Workers の `fetch` から sandbox の APNs に送れるかを確かめる、検証専用の Worker。運営の API とは別に配置する。D1、Cron、X の接続は使わない。

## 送るものと残すもの

- 送信先は `api.sandbox.push.apple.com`、topic は `com.twitter-studio.Tweetbot` に固定する。通知文も固定し、本文や送り先の指定を受けない。
- `.p8` の鍵は Mac に残す。ローカルの Node.js で ES256 の JWT を作り、署名済みの provider token だけを Cloudflare の secret に置く。APNs の JWT 自体の有効期間は発行から最大1時間で、下の10分の入口制限とは別。
- 検証用の bearer と有効期限を別に持つ。CLI が作る検証窓は10分で、Worker は期限切れと15分を超える窓を拒む。ブラウザ向けの CORS は許可しない。
- デバイストークンは要求の本文で受け、保存しない。応答には写さない。要求・subrequest の自動ログと trace は無効にする。`wrangler tail` や、本文・ヘッダー・送信先を出すデバッグを使わない。
- リダイレクト、再試行、HTTP/1.1 向けの代替経路は作らない。1回送って、APNs の status、UUID 形式の `apns-id`、許可した reason、経過時間だけを返す。
- HTTP の版と CPU 時間は `Response` にないため、応答はそれぞれ `not_exposed` と `null`。経過時間を CPU 時間として書かない。

## 配置の前提

実行前に、オーナーの明示の承認を得る。この節の CLI 配置は、AGENTS.md の「デプロイは、保護した GitHub の Environments と、範囲を絞った Cloudflare の資格情報で行う」に対する、一度限りの運用上の例外の承認も必要とする。承認がなければ、次の手順を実行せず、GitHub Environment を経由する配信を用意する。

承認の対象は、検証用 Worker の作成、短命の3つの secret の配置、実機への検証通知、測定後の Worker と短命のローカルファイルの削除。APNs の `.p8` 自体は Cloudflare や GitHub に渡さない。D1 や有料リソースは作らない。既存の Worker には触れない。

Apple Developer では、Sandbox・Topic Specific・Tweetbot だけに限定した鍵を使う。App Store Connect API 用の鍵とは別物。

## ローカルの準備

`apps/apns-probe` で実行する。Node.js と Wrangler はリポジトリの固定版を使う。

```sh
mise exec -- pnpm typecheck
mise exec -- pnpm test
mise exec -- pnpm build
```

`.p8`、短命の secret、デバイストークンのファイルは Git 管理外で、ディレクトリを0700、ファイルを0600にする。CLI は Git 管理内への secret の書き出し、既存ファイルの上書き、他のユーザーが読める秘密ファイルを拒む。実機の token はログやチャットで回収せず、安全な取得経路が用意できるまで実送信をしない。

## 承認後だけ実行する手順

最初は secret がないので、Worker は要求を受け付けない。

```sh
mise exec -- pnpm exec wrangler deploy --config wrangler.jsonc
```

配置結果の `*.workers.dev` origin が対象アカウントの検証 Worker のものかを確認する。`APNS_KEY_PATH`、`APNS_KEY_ID`、`APNS_TEAM_ID` は手元で指定する。値を含む秘密鍵をコマンド引数にせず、ファイルのパスだけを渡す。

```sh
APNS_PROBE_DIR=$(mktemp -d)
mise exec -- node scripts/probe.mjs prepare \
  --private-key "$APNS_KEY_PATH" --key-id "$APNS_KEY_ID" --team-id "$APNS_TEAM_ID" \
  --out "$APNS_PROBE_DIR/credentials.json"
mise exec -- pnpm exec wrangler secret bulk "$APNS_PROBE_DIR/credentials.json" --config wrangler.jsonc
```

この `secret bulk` も公開中の Worker を更新する操作。CLI は値を標準出力に出さない。検証中に provider token を繰り返し作り直さず、同じ検証窓では同じファイルを使う。

`APNS_DEVICE_TOKEN_FILE` は `{"device_token":"小文字の16進数"}` というローカルの0600ファイルのパス。コマンド引数、環境変数の値、URL、スクリーンショット、ログへトークンを出さない。

```sh
mise exec -- node scripts/probe.mjs send \
  --origin "$APNS_PROBE_ORIGIN" --credentials "$APNS_PROBE_DIR/credentials.json" \
  --token-file "$APNS_DEVICE_TOKEN_FILE"
```

`send` は origin の余分な path、query、HTTP、HTTP リダイレクトを拒む。要求の内容は出力せず、返された結果も型を検証し、宣言外の項目を捨ててから出力する。CLI の終了コードが0でも、APNs の200を確認しただけで、実機への到達を保証しない。APNs の200以外と通信失敗では0以外で終わる。

## STOP/GO の記録

Issue #7 に、秘密を含まない次の項目を残す。

- 配置した commit、実行時刻、対象の sandbox / topic。
- 応答の request ID、APNs status、`apns-id`、reason、経過時間。
- 実機で通知を見たか。HTTP 200 だけでは到達済みとしない。
- HTTP の版は直接観測できていないこと。APNs は HTTP/2 を要求するため、直接の sandbox endpoint が受け付け、実機に届けば、HTTP/2 で接続できたという推論の根拠にする。
- Cloudflare の Analytics で確認できた CPU 時間と、対象の時間帯・要求件数・集計方法。確認できなければ未測定と書き、STOP/GO の未確認項目に残す。

届かなければ APNS-001 を閉じず、HTTP/2 を明示できる中継との比較を ADR に書く。HTTP/1.1 に黙って切り替えない。

測定を記録したら、承認した検証用 Worker を削除する。短命の secret と device token のローカルファイルも削除する。元の `.p8` は本人だけが読める Git 管理外の保存先に残す。

```sh
mise exec -- pnpm exec wrangler delete --config wrangler.jsonc
```

## 根拠

- [APNs への接続: HTTP/2 と TLS の要件](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns)
- [APNs の JWT と更新間隔](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [APNs への要求とヘッダー](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Cloudflare Workers のログ](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

この Worker は APNS-002 の本体ではない。JWT の長期更新、端末の所有確認、410 の無効化、通常の通知の送信と回数制限は、到達確認の結果を受けて APNS-002 に実装する。
