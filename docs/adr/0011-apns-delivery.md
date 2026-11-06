# ADR-0011: APNs の署名、所有確認と遅延再送

Status: Accepted / 2026-11-04

## 背景

[APNS-001 の実測](../verification/2026-11-04-apns-sandbox.md)で、配置した Worker から sandbox の APNs に直接送り、実機へ届くことを確認した。APNS-002 ではこの送信経路を使う。Apple は5xxの再試行まで15分待つことを求めるため、ADR-0009 の60秒の送信枠の中で短い間隔の再試行はできない。

## 決定

### 鍵と JWT

- `APNS_PROVIDER_KEYS` は Cloudflare secret に置く JSON 配列。各要素は `environment`、`topic`、`key_id`、`team_id`、`private_key` (PKCS8 PEM) だけを持つ。
- Sandbox・Topic Specific の鍵は、その環境と Bundle ID だけに設定する。production には別の鍵を用意する。同じ環境と topic の重複、同じ Key ID の重複を拒む。環境や topic を満たす鍵がなければ送らない。
- 未設定なら通知を送らない。壊れた APNs 設定も配信だけの失敗にし、health、登録、資格情報の取り消しなどを止めない。
- Workers の Web Crypto で P-256 / ES256 を署名する。JWT の header は `alg`、`kid`、claims は `iss`、`iat`。署名は64バイトの IEEE P1363。
- isolate 内で署名鍵と JWT を共有し、同時の要求には同じ署名処理の Promise を返す。JWT は50分未満なら再利用する。50分後に更新し、時計が戻った場合は新しい JWT を急いで発行せず失敗にする。
- APNs への要求は10秒まで、リダイレクトなし。sandbox / production の固定 endpoint 以外へ送らない。呼び出し元の中止にも従う。
- `200` は受け付け。`403` は認証失敗の構造化 error を出し、その場で署名し直したり再試行しない。ほかの恒久失敗も再試行しない。外部の本文や例外の文、送信先 URL はログへ出さない。

### 無効なトークン

- `400 BadDeviceToken` と `410 Unregistered` は無効として扱う。410 は APNs の `timestamp` (UNIXミリ秒) があるときだけ無効化する。
- 無効化では、送ったときの暗号文 (登録のたびに新しい IV を持つ)、指紋、環境、topic を SQL で照合する。書き換え時刻も、送信開始時刻と410の timestamp の早いほう以前であることを求める。
- 同じトークンを登録し直した場合も暗号文が変わるため、遅い応答で新しい登録を止めない。古い410の timestamp より後の登録も止めない。

### 遅延再送

- 通常は HTTP 要求の中で1回だけ送る。一時障害 (`429`、`5xx`、通信障害・タイムアウト) だけを `notification-apns-retries` Queue に渡す。
- `429` と通信障害は60秒、5xxは900秒を最初の基準にする。次は2倍 (基準の上限1800秒)、0〜10%の正の jitter を加える。15分より短い5xxの再送はしない。
- Queue は `max_batch_size = 1`、`max_retries = 1`。通常の流れで初回と Queue の2回、計3回まで送る。consumer も試行回数を検査する。期限は最初の送信から1時間。期限切れは捨てる。
- Queue への書き込みに失敗したら中継の入口は503にする。ADR-0009 のリースを解放し、利用者の Worker の再試行を受ける。Queue に渡せた結果は `queued` として中継の受け付けを済みにする。
- Queue にはアカウント・端末・受け付けた資格情報の ID、指紋、環境、topic、collapse ID、APNs ID、期限、通知の payload（設定されている場合はプレビューを含む）を置く。平文のデバイストークン、署名鍵、JWT、所有確認 code は置かない。
- 再送のたびに、D1 で資格情報のアカウント、取り消し、期限と、端末の所有・有効状態・所有確認・指紋・環境・topic を読み直す。削除、通知停止、インストールの取り消し、トークン更新後は送らない。中継の資格情報を取り消し・入れ替えした場合も、その資格情報で受理した待機中の仕事を捨てる。
- APNs ID と collapse ID は再送でも変えない。APNs の受け付け後に接続が切れる場合や Worker が落ちる場合、重複は残りうる。到達も重複排除も厳密には保証しない。
- 上限・恒久失敗は ack して error を出す。Dead Letter Queue は置かず、個々の失敗した本文を運営に見せる管理画面も作らない。通知が欠けうることと、集計で異常を検知する運用は QA-001 で確かめる。

### 所有確認

- `DeviceVerificationSender` は `aps.content-available = 1`、`verification.device_id`、`verification.code` を持つ background push を送る。`apns-push-type = background`、priority 5。code は alert の文に入れない。
- 期限は登録の code と同じ10分。遅延再送へは渡さない。background push は iOS が遅らせたり落としたりするので、アプリは届かなければ同じトークンを登録し直し、新しい code を受ける。
- IOS-001 は自分の端末 ID と code の形を検査して、所有確認 API に返す。バックグラウンドの受信と通知タップ、アプリ本体の訳は、iOS 側の受け入れ条件に残る。

### 費用と配置

- 2026-11-04 の公式資料では、Queues の Free は1日10,000 operations、保存24時間。64KB未満の1メッセージは write / read / delete が各1 operationで、再試行は追加の read。
- この Queue は失敗した端末だけを扱う。2回の consumer と ack までなら1件4 operations。アカウントの1日1,000イベントが1端末すべて一時障害になれば4,000 operations。2アカウントで8,000、3アカウントで12,000となり無料枠を超える。他の Queue ともアカウントの枠を共有する。無料で無制限に使えるとはしない。
- 再送のたびに資格情報と端末の読み直しも増える。Queues の呼び出し、Workers の CPU、D1 の読み込みを合わせた実測と招待数の制限を QA-001 の配置ゲートにする。
- 実リソースの作成、APNs の秘密鍵の Cloudflare への保存、運営 API の配置はまだ承認していない。APNS-001 の一時 CLI 配置の承認を流用しない。保護した GitHub Environment と範囲を絞った資格情報での配置を原則とする。
- invocation logs と traces は無効にし、決まった項目の構造化 console log だけを残す。APNs の URL、ヘッダー、要求・応答の本文を記録するデバッグや tail は使わない。

## 根拠

- [Apple: token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [Apple: APNs responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)
- [Apple: background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)
- [Cloudflare: Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare: Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare: retries and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare: invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

## 初期配置

2026-11-04、オーナーの明示承認と今回限りの CLI 配置の例外承認を受け、sandbox 検証用の構成を配置した。[配置の記録](../verification/2026-11-04-sandbox-deployment.md) を参照。production と今後の別の配置は、この承認に含めない。
