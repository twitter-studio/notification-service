# ADR-0013: 通知の集計ログと監視の判定

Status: Accepted / 2026-11-04

## 背景

QA-001 で、通常配信・Queue の経路・通知タップの実機証拠はそろった。一方、再送・破棄・HTTP エラーを識別子や本文なしで集計する記録と、警報の判定が不足していた。外部の例外では `message` だけでなく `name` にも秘密が入りうる。

## 決定

- `src/telemetry.ts` のイベント別スキーマで項目と値を限定する。余分な項目は取り除き、不正なイベントは記録せず、配信を止めない。
- `console.info` にオブジェクトを渡す。Workers Logs が構造のあるフィールドとして扱える形にし、既存の固定エラーログも併用する。
- `http_request`: サーバーが生成した `request_id` と HTTP `status` のみ。要求の URL、path、query、ヘッダー、本文、IP は渡さない。
- `notification_accepted`: `request_id` と `accepted` / `duplicate`。APNs への到達とは区別する。送り先なしでも accepted となる。
- `apns_response`: HTTP status と alert / background のみ。APNs の200は受け付けであり、実機表示の証拠とはしない。
- `delivery_retry`: 最初の Queue 投入 / consumer の再予約、consumer 試行番号、遅延秒数のみ。
- `delivery_discarded`: 試行上限、不正形式、期限外、権限失効、端末の停止・更新による不一致を固定の理由で区別する。
- アカウント、インストール、端末、通知、APNs の ID、指紋、トークン、暗号文、署名鍵、JWT、所有確認 code、外部の応答本文、例外の値は新しい集計へ含めない。既存の例外名・掃除失敗のアカウントIDのログも除く。
- `redact_query_string = true` でプラットフォームが残す URL から query を除く。invocation logs と traces は引き続き無効にする。プラットフォームが付ける metadata までアプリのテストで安全と証明したとはみなさず、実環境で別に確認する。認証ヘッダーの自動秘匿には依存しない。

## 警報の判定

`src/monitoring.ts` は5分の完全な集計を検証する。項目の欠落、余分な項目、負数、総数と矛盾する分類数は `invalid`。取得失敗を0件へ置き換えない。集計値と raw logs は別の入力であり、CLI に raw logs を渡さない。

| 条件                      | 初期閾値                          |
| ------------------------- | --------------------------------- |
| APNs の403 / 再送打ち切り | 1件以上                           |
| HTTP の5xx                | 5件以上、かつ5%以上               |
| HTTP の401・403           | 計20件以上、かつ10%以上           |
| HTTP の429                | 10件以上、かつ20%以上             |
| APNs の5xx                | 5件以上、かつ5%以上               |
| APNs の429                | 5件以上、かつ10%以上              |
| Queue の停滞              | backlog > 0、最古の age >= 3300秒 |

Queue の閾値は、5xx の初回990秒と次の1980秒、通信の待ち時間を含む通常の上限より長くする。一定の通知量を保証する SLO ではなく、招待制 sandbox の初期値。運用後の観測で調整する。

`pnpm --filter @notification-service/api check-alerts <aggregate.json>` は正常0、警報2、不正・読取失敗1で終了する。固定の警報名だけを出力する。定期取得、Cloudflare Monitors の登録、メール等への送信は行わない。実際のデータ取得、定期判定、受信先への到達は運用の受け入れゲートとして別に確認する。

## 採らなかった案

- すべての要求や例外を保存して後から秘匿する: 秘密がいったん保存されてしまう。
- アカウントIDやトークンの指紋で集計する: 配信異常の検知には総数で足り、不要な識別子を運営ログへ増やす。
- APNs の再送を短縮して実験する: Apple の5xxの待機条件と実運用を確かめる試験にならない。
- 運営 Worker に障害注入用の公開入口を足す: 実端末・実 DB の配信と混ざる。実環境の故障試験は分離した構成で行う。

## 根拠

- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/): オブジェクトのログと invocation logs の無効化
- [Monitors](https://developers.cloudflare.com/notifications/monitors/): 定期 query と検知・通知
- [Telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/): 現行の必要権限は Workers Observability Write

## 実環境の metadata (2026-11-04)

専用の観測用トークンで実環境の集計 API が200になった。既存のアプリログ2件の metadata には HTTP method・URL・path があり、headers はなかった。アプリのログを限定してもプラットフォーム側の URL が消えるとは限らないため、query の秘匿設定を明示する。path は引き続き残りうる。URL に資格情報を載せない API 契約は維持し、任意の path を含めた完全な匿名化を達成したとはしない。

## SQL監視の具体化

[制約 #35](https://github.com/twitter-studio/notification-service/issues/35) により、statusのJSON属性をCASE / countIf内で集計するSQLは422となった。検証済みstatusから `server_error_count`・`auth_error_count`・`throttled_count` の0/1値を作り、直接のSUMとCOUNTで同じ件数・割合の閾値を表す。受信したカウンターの値は使わない。

Queueは既存Workerの5分Cronで `metrics()` を呼び、件数と最古の待機秒数だけを `queue_state` に記録する。取得失敗や最古時刻の欠落は固定の `queue_metrics_unavailable` とし、正常な空の状態にしない。5分Cronは1日288回。要求・CPU・ログの使用量が増えるため招待数拡大前の費用検証に含める。

`ops/notification-monitors.json` は宛先をプレースホルダーにした無効状態の定義。対象は固定アカウントと通知Workerのみ。基本8条件に加え、Queueの観測失敗1件、10分間のQueue heartbeat欠測にも警報を出す。実アカウントでカスタム監視の上限が5件だったため、条件を変えず、重大異常・HTTP率・APNs率・heartbeat欠測の4系統にまとめる。評価は5分ごと、再通知は1時間ごと。実アカウントの `logs.workersLogs` は5分の無効policyを受理した。この結果をLog Explorerの最小10分の制約へ一般化しない。

API Tokens の権限は Workers Observability Edit に加え、オーナーが Account Analytics Read と Notifications Edit を承認・追加した。秘密は引き続きMacの保護ファイルのみで読む。メール宛先や資格情報を定義ファイルへ書き込まない。定期評価と到達の確認前に、警報運用が完了したとはしない。
