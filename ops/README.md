# 通知Workerの監視定義

`notification-monitors.json` は QA-001 の通知用 Worker だけを対象にする Cloudflare Monitors の定義。資格情報とメール宛先は含めない。`ALERT_EMAIL` は配置時にオーナーが承認した宛先へ置き換える。

## 適用

- APIは `POST /accounts/{account_id}/alerting/v3/policies`、種類は `custom_analytics`、source は `sql_api`。SQLは `filters.selectors` の文字列配列。短い窓と評価間隔は `5m` のようなDurationの文字列で、秒の数値文字列ではない。
- 既定は無効。SQLを同じアカウントの `POST /analytics/sql` で検証し、実環境のログに必要な数値カウンターと Queue heartbeat があることを確認してから有効にする。
- 同名の既存定義を更新するときは、種類・SQL・対象アカウントとWorkerの一致を確認する。別の監視や宛先を上書きしない。無効な参照定義をそのまま既存の稼働状態へ上書きしない。
- 通知のテストは `POST /accounts/{account_id}/alerting/v3/policies/{policy_id}/test`。オーナーが認めた宛先と回数だけを実行する。受け付け、送信履歴、実際の受信は別に確かめる。
- 資格情報をコマンド引数、ソース、Git、出力へ置かない。権限や有効期限の変更はオーナーの承認を得る。

## 集計の範囲

アカウント・Worker・時間窓をSQL内で固定し、結果は `value` という数値だけにする。通常は5分の窓を5分ごとに評価し、再通知は1時間ごと。Queue heartbeatの欠測は10分の窓を使い、最初のheartbeatを確認する前は有効にしない。

SQL側のJSON条件付き集計の制約は service #35 で追跡する。直接SUMできる0/1カウンターで、CLIと同じ件数・割合を表す。SQL APIはサンプリングの重みを集計に反映するため、値を常に正確な実件数とはしない。

CPU・D1・Queueの費用と障害試験の結果は `docs/verification/2026-11-04-qa.md` を参照する。通知の200、正常な窓の判定、テストメールの成功だけで、障害時の自動再送やリリース条件を満たしたとはしない。


通常配置と復旧は [Environment経由の配置手順](deployment.md) を参照する。
