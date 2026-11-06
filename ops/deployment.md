# 運営sandboxを承認付きで更新する

対象は停止中の既存sandbox。`.github/workflows/deploy-sandbox.yml` はmainの手動実行専用で、リソース作成・secret登録・X API操作・productionへの切替は行わない。

## 有効化前の設定

実Environment・限定token・有効化・配置は所有者が対象と費用を確認して承認する。リポジトリを公開しただけでは配置を開始しない。公開前のFree/privateでは必要な保護を使えなかったため、実設定とEnvironment経由の配置検証は未完。

1. `sandbox` Environmentを作る。D1 migration用には別の `sandbox-migrations` も作る。
2. Required reviewersは承認する本人のUserを1人だけにする。repo variable `DEPLOY_REVIEWER` に同じloginを設定する。mainのbranchルールだけを1件登録し、tagや追加branchを許可しない。
3. 管理者の保護ルールbypassを無効にする。本人が起動と承認を行う場合はPrevent self-reviewをオフにする。実操作前に当該runの本人承認履歴も検査する。
4. repo variable `SANDBOX_DEPLOY_ENABLED` は未設定またはfalseで準備し、保護と資格情報を確認してから所有者が有効化する。秘密はEnvironment secretへだけ保存する。

## Environment variablesと資格情報

| Variable                | 内容                                               |
| ----------------------- | -------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | 承認したアカウントID、32桁hex                      |
| `WORKER_NAME`           | 対象の既存Worker名                                 |
| `CF_WORKER_SUBDOMAIN`   | workers.devのアカウント部分。独自ドメインは対象外  |
| `CF_QUEUE_ID`           | 既存Queueの32桁hex ID。名前とbindingも照合する     |
| `D1_DATABASE_ID`        | 既存D1のUUID。2つのEnvironmentに同じ対象を設定する |

運営のWorker名とD1名は `notification-service`、Queue名は `notification-apns-retries`。招待制・developmentを維持する。配置前は既存KCV・許可バージョンを保った追加だけを認め、配置後は対象設定との完全一致を求める。

`sandbox` tokenは対象アカウント・WorkerのEditorと既存Queue consumer更新、必要なD1 Readに絞る。`sandbox-migrations` tokenは対象D1のEditだけとし、WorkersやQueuesの書き込み権限を加えない。個別リソースへのscopeが使える場合は限定し、実際の発行画面で確認する。

Cloudflare tokenだけを `CLOUDFLARE_API_TOKEN` というEnvironment secretに保存する。運営と利用者、配置とmigrationで共有しない。APNs鍵・Xの資格情報・中継資格情報・暗号鍵はCloudflare側に保持し、GitHubへ複製しない。権限不足やプラン変更が必要なら止め、勝手に範囲を広げない。

## 通常更新

mainの対象SHAのpush CI成功を待ち、購読解除・送信停止・Queue件数とbytesが0を確認する。purgeで空にしない。mainから手動実行し、`target_sha` に完全SHA、`confirmation` に `deploy:完全SHA` を指定し、保守確認にチェックする。operationはdeployにし、schema確認にもチェックする。本人が対象SHAと設定・停止範囲を確認してEnvironmentを承認する。

成功時は `sandbox_deployed` と稼働版が出る。Workflowはvars・secret名・binding、稼働版100%、Queue空、Cron、healthを確認する。別途、heartbeatと警報の保持を確認する。healthを通知到達の証明にしない。

失敗runのRe-run jobsは拒否する。実際の稼働版・設定・Queueを確認し、新しい手動runと承認で行う。失敗しても未配置とは限らない。自動rollbackはしない。

## D1 migration

SQL・対象D1・旧コード互換性をレビューし、アプリ・中継・Cron・consumerを含む書き込み停止と復旧地点を確認する。DB内容やbackupをCIログへ出さない。別runでoperation=migrate、`migrate:完全SHA`、保守とbackupの確認を指定し、本人が `sandbox-migrations` を承認する。

`migration_applied` 後も適用状態と整合性を保護した管理経路で確認し、その後に別runでWorkerを更新する。停止とbackupのチェックは本人が確認する前提条件で、Workflowが全書き込み元や復旧内容を証明するものではない。DBの復元は正しい更新や削除・失効状態も巻き戻すため、影響を別途承認して行う。

## 追加の運用資料

詳細な障害・鍵更新・削除の運営用手順は [notification-docs](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/recovery.md) にある。非公開資料のため、アクセスできる管理者だけが参照する。公開コードの提供と、実際の運営サービスの利用登録・公開運用の承認は分ける。

仕様の根拠: [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[Cloudflare権限](https://developers.cloudflare.com/workers/authorization/workers/)。

## productionの実機検証用Worker

対象は `notification-service-prod-verification` のWorkerとD1、`notification-apns-prod-verification` のQueueだけ。[検証計画](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/2026-11-05-qa003-production-plan.md)に沿って、初期リソースの作成・権限付与・秘密登録をそれぞれ承認後に実施する。

1. 検証用Queueを保持24時間で作り、専用のD1と、外部入口を持たない初期Workerを用意する。初期Workerの平文変数は `PRODUCTION_VERIFICATION_BOOTSTRAP=true` だけとし、運営用の5つの秘密をCloudflareに登録する。Appleの鍵と登録用の秘密はGitHubのEnvironmentへコピーしない。
2. `production-verification` と `production-verification-migrations` を作り、本人1名のrequired reviewer・main限定・管理者bypass禁止を設定する。資格情報を分け、migrationは対象D1のEdit、Worker配置は対象WorkerのEdit・対象アカウントのQueues管理・D1 Readに絞る。
3. 両Environmentに `CLOUDFLARE_ACCOUNT_ID`、`CF_WORKER_SUBDOMAIN`、`CF_QUEUE_ID`、`WORKER_NAME`、`D1_DATABASE_ID`、`PROD_BUNDLE_VERSION`、`PROD_DEVICE_TOKEN_KEY_CHECKS` を設定する。build番号は配布物と同じ値にする。KCVには専用鍵の値を使い、`keys` の項目名を `prod-verification` とする。
4. `PRODUCTION_VERIFICATION_DEPLOY_ENABLED` は既定false。承認された作業中だけtrueにする。 `Production notification verification` をmainのCI成功SHAで起動し、初期migrationとWorker配置を順に別runで承認する。作業後は有効化変数をfalseへ戻す。
5. Worker名、D1・Queueのbinding、App Attestのproduction設定、稼働版100%、Queue空、Cron、healthを照合する。最初の実機登録後は招待secretの削除を別途実施し、既存登録のセッション更新とsandboxの稼働状態を確認する。

この手順は承認された初回の1ビルドに限る。配置済みWorkerとの設定照合は完全一致を要求する。別のbuild番号で試験をやり直す場合は、検証アカウントと旧配布物の扱いを確定し、設定差分と配置を改めてレビューする。

## 公開用productionを閉じた状態で準備する

対象は `notification-service-production` のWorkerとD1、`notification-apns-production` Queue。sandboxとproduction検証用の資源を再利用しない。最初のmigrationとWorkerの配置は登録・配送を閉じた状態で別々に行う。通常運用への切り替えは、初期配置後に別runで行う。

1. オーナーの承認後、専用D1とQueueを作り、外部の入口を持たず404だけを返す[初期Worker](../apps/api/public-bootstrap/wrangler.jsonc)を用意する。初期Workerの平文変数は `PUBLIC_PRODUCTION_BOOTSTRAP=true` のみ。APNs provider鍵、チャレンジ署名鍵、端末トークンの暗号鍵束と指紋鍵を、対象Workerのsecretに置く。公開用の端末トークン鍵とチャレンジ鍵は別途生成する。APNs鍵の選定と運用対象は承認記録に残す。
2. GitHubの `production` と `production-migrations` を本人1名のrequired reviewer、main限定、管理者bypass禁止で設定する。配置とmigrationの資格情報を分ける。必要な権限は配置先Workerだけの編集、D1参照、Queue管理と、migration先D1の編集。migrationの停止照合には、公開WorkerとQueueを参照できる別の読み取り専用トークンを使い、`production-migrations` Environmentの `PUBLIC_WORKER_READ_TOKEN` に保存する。トークンの発行は対象と権限を確定してから別途承認する。配置前にCloudflareのWorker情報から公開URLを照合する。個別に絞れない権限は、発行前に許可範囲を記録する。
3. 両Environmentの変数に `CLOUDFLARE_ACCOUNT_ID`、`CF_WORKER_SUBDOMAIN`、`CF_QUEUE_ID`、`WORKER_NAME`、`D1_DATABASE_ID`、`PROD_BUNDLE_VERSION`、`PROD_DEVICE_TOKEN_KEY_CHECKS` と `VERIFICATION_DEVICE_TOKEN_KEY_CHECKS` を指定する。公開用のKCVの鍵IDは `production`。検証用KCVは検証用Environmentの実値と照合する。KCVだけを変数に保存し、鍵をコピーしない。
4. リポジトリの `PUBLIC_PRODUCTION_DEPLOY_ENABLED` は通常false。作業中だけtrueにし、`Public production deployment` をmainのCI成功SHAで起動する。専用D1に初期migrationを適用した後、別runでWorkerを配置する。既存の公開環境にmigrationを当てる前には、別runで登録・配送を停止し、書き込み元とQueueの停止を照合する。Workflowも100%稼働中の単一版の両スイッチがfalseで試験枠がなく、専用Queueが空であることを読み取り確認する。停止構成でもセッション更新、削除、資格情報の操作、CronはD1へ書き込む。これらと互換性のないmigrationでは個別の停止手順と承認を先に用意する。初期migrationでは、初期Workerとproducer・consumerのない専用Queueを照合する。各runはオーナー本人がEnvironment承認を行う。
5. `public_production_closed_deployed`、health 200、登録403、専用のbindingとQueue空を確認する。公開用のApp Attestは `required` と `production`、招待secretは存在しない。両スイッチはfalse。完了後は配置有効化変数をfalseに戻し、migration用の資格情報を整理する。

対応する配布候補と利用条件は [RELEASE-001](https://github.com/twitter-studio/notification-docs/issues/3) で確認する。

### 内部TestFlightの実機試験

1. オーナーと対象ビルド、端末、終了時刻を確定する。`PROD_BUNDLE_VERSION` に配布後のビルド番号を指定する。32バイトの乱数をパディングなしBase64URLにした招待コードを保護ファイルに保存し、試験端末の操作者に渡す。
2. `Public production deployment` の `deploy` を `public_mode=closed` で起動し、`trial_until` に2時間以内のUTC終了時刻を指定する。`trial_invite_hash` には招待コードの文字列をSHA-256でハッシュし、パディングなしBase64URLにした値を渡す。オーナーが `production` Environment を承認する。Workflowは通常の登録・配送が閉じ、D1に登録がなく、Queueが空であることを確認してから配置する。
3. `public_production_trial_deployed` を確認する。実機で招待コードを入力し、App Attest登録、端末所有確認、テスト通知を確認する。新規登録は1件だけ受け付ける。終了時刻を過ぎると、新規登録とAPNsへの新規送信は停止する。APNsが既に受理した通知は端末に届く場合がある。
4. 試験が終わったらQueueが空であることを確認し、試験入力を空欄にして閉鎖配置を起動する。本人承認後、登録403、`PUBLIC_TRIAL` の解除、`PUBLIC_PRODUCTION_DEPLOY_ENABLED=false` を確認する。

前回の試験で登録が済み、所有確認やテスト通知を再試行する場合は、同じビルドと端末を使う。`trial_resume=true` と `trial_until` を指定し、`trial_invite_hash` は空欄にする。Workflowは前回の登録1件とproductionのApp Attestおよび端末登録を照合する。再試験の配送は登録済みのAPNsトークンへの所有確認とアプリ内のテスト通知に限る。中継はHTTP入口で拒否し、Queueに届いた中継の再送も破棄する。

実 X のメンションと返信を確認するときは、同じ再試験入力に `trial_relay_credential_id` を加える。Workflowは指定した資格情報が登録済みのアカウントに属し、端末の所有確認が済んでいることを照合する。指定資格情報のメンションと返信だけを中継し、HTTPとQueueの両方で照合する。試験後は通常の閉鎖配置に戻し、試験で使用した中継資格情報をアプリから取り消す。

### 通常運用を開始する

1. オーナーと対象ビルド、登録と配送を開始する範囲、停止担当を確定する。専用Queueが空で、以前の中継イベントが再送されないことを確認する。必要に応じて旧中継資格情報を取り消し、利用者側の購読とQueueも照合する。[利用開始と停止の手順](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/public-notification-lifecycle.md)
2. `Public production deployment` を `operation=deploy`、`public_mode=open`、`confirmation=deploy-open:完全SHA` で起動する。試験用の入力は空にし、対象buildを `PROD_BUNDLE_VERSION` と照合する。オーナー本人が `production` Environment を承認する。
3. `public_production_open_deployed` を確認する。Workflowは配置後に登録・配送の設定が両方trueで、healthが200であることを照合する。登録入口には無効なチャレンジを送り、アプリから401が返ることを確認する。実際の登録、所有確認、配送は対象端末で別途確認する。終了後は `PUBLIC_PRODUCTION_DEPLOY_ENABLED=false` に戻す。

通常運用への配置runが失敗した場合は、稼働版と両スイッチを確認する。通常運用が反映されていて停止が必要なら、次の手順で緊急停止する。

### 登録と配送を緊急停止する

1. 同じWorkflowを `operation=deploy`、`public_mode=stop`、`confirmation=deploy-stop:完全SHA` で起動する。試験用の入力は空にする。Queueに待機ジョブがある状態でも、オーナーが `production` Environment を承認すると停止構成を配置できる。
2. `public_production_stop_deployed`、登録403、登録と配送の設定が両方false、試験枠の解除を確認する。停止したWorkerが受け取る再送ジョブは破棄される。切り替え前に始まった処理や、APNsが受理済みの通知は端末へ届く場合がある。Queueの件数と利用者側の状態を確認し、配置有効化変数をfalseに戻す。
