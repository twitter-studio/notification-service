# 隔離した Cloudflare 障害試験

QA-001 の未完了ゲートを確認する専用構成。運営の Worker / D1 / Queue へは接続しない。通常の `wrangler.jsonc` には入口を追加しない。

## 試験の境界

- `notification-qa-faults` という Worker・D1・Queue を各1つ使う。D1 の ID は初期状態では無効。作成・migration・配置はオーナーの承認後だけ行う。
- 実物の `ApnsClient` と `ApnsPushGateway` を使う。送信 transport は必ずプロセス内の合成応答に差し替える。Apple / X / 実端末へ送信しない。実サービスの鍵・DB・Queue をコピーしない。
- 合成 P-256 鍵、暗号化鍵、指紋鍵、管理トークンを専用に生成し、Cloudflare secret に保存する。topic は `com.twitter-studio.NotificationQALab`、Key ID は `TESTKEY001`、Team ID は `TESTTEAM01` に固定。値は出力しない。
- `QA_ADMIN_TOKEN` は `qa_` + base64url 43文字。Authorization Bearer だけで受け取り、URL に入れない。`QA_DEADLINE` は開始前に UNIX ms で指定し、2時間以内に失効させる。既定値0では動かない。
- `POST /start` は D1 の単一行で一度だけ実行できる。途中失敗でも再実行できない。`GET /results` は合成ケース名・status・時刻・端末状態・isolate数だけを返す。トークン、JWT、暗号文、識別子は返さない。
- HTTP は全体で毎分おおよそ120件に制限し、CPU上限は1秒。Queue は batch1・並列1・再試行1。期限を過ぎた合成ジョブは ack して終了する。

## ケースと判定

| ケース                         | 合成応答と期待値                                                       |
| ------------------------------ | ---------------------------------------------------------------------- |
| sent                           | 初回200、再送なし                                                      |
| recover429                     | 初回429、60〜65秒後の Queue で200                                      |
| exhaust503                     | 初回503、900〜989秒後に503、さらに1800〜1979秒後に503で打ち切り        |
| disabled / revoked / rotated   | 初回429後に端末停止・資格情報失効・トークン更新。Queueでは送信せず破棄 |
| bad-token400 / unregistered410 | 初回の応答で端末をinvalidatedにし、Queueへ入れない                     |

Queue の at-least-once 配信で重複が起こった場合は試行の実測を記録し、期待した回数に読み替えない。JWT の iat と isolate 数も記録する。複数 isolate が観測できなければ、そのゲートは未完了のまま残す。APNs の応答分類を合成した試験であり、Apple の障害や実機到達の証拠にはしない。

## 実行と削除

1. ローカル: `mise exec -- pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build`。専用構成は API のディレクトリから `pnpm exec wrangler deploy --config qa/wrangler.jsonc --dry-run`。ローカルテストは workerd と隔離D1に生成migrationを当て、Queueの実物のバッチを使う。時計の待機やCloudflareへの配置は行わない。
2. 承認後、同名リソースが存在しないことを確認する。Queueは保存期間86400秒で作り、D1 IDを専用の一時構成にだけ設定する。`qa/migrations` だけを新規DBへ当てる。通常のAPI用migrationコマンドは使わない。
3. 固定名・専用ID・Queue・合成鍵のラベル・期限を照合して配置する。`.dev.vars` と secret の値はリポジトリ外の0700ディレクトリ・0600ファイルで扱う。手元の通常API用 `.dev.vars` は使わない。
4. startを1回、resultsの観測と負荷を合わせて最大100リクエスト・並列5以下で実行する。結果以外の本文や raw logs を保存しない。初回8件、通常のQueue再送3件の合成APNs処理を期待する。D1読み書き・Queue待機・CPUを数値集計で確認する。途中失敗時は試験を止め、件数を追加しない。
5. 約50分後の最終結果とQueueの空を確認し、Worker → Queue → D1 の順に削除する。削除対象は作成時に記録したIDのみ。失敗した削除は成功扱いにしない。保護ファイルの合成秘密も削除する。

## 費用と未実施のゲート

既存プランを変えない。アカウント全体の使用量によって従量課金があり得るため、無料とは保証しない。作成前に [Workers](https://developers.cloudflare.com/workers/platform/pricing/)・[D1](https://developers.cloudflare.com/d1/platform/pricing/)・[Queues](https://developers.cloudflare.com/queues/platform/pricing/) の現行料金と既存リソース数を確認する。上記の回数・期限は試験側の制限であり、アカウント全体の請求額のハード上限ではない。

この小規模試験で招待数拡大時の負荷を証明したとはしない。CPU・D1・Queue の実測を残し、拡大前の別ゲートで想定件数から費用を算出する。初期状態ではリモートリソースの作成・試験は未実施。
