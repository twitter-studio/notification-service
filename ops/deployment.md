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
