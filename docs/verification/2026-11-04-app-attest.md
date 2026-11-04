# AUTH-003の検証と残る実機ゲート

2026-11-04。Issue: [notification-service#15](https://github.com/twitter-studio/notification-service/issues/15)。設計は[ADR-0014](../adr/0014-app-attest.md)。

## 完了した検証

- API: lint、typecheck、workerd 323件、運用スクリプト4件、dry-run buildが成功。probeの既存14件とCLI 5件も成功。
- D1: 通常・QAの両Drizzle構成で再生成差分なし。初回登録、pendingからの昇格、counterの同時更新、アカウント削除競合、鍵置換と送信前切断からの回復を検証。
- iOS: XcodeMCPKitでビルドし、715件がすべて成功。未実行・失敗なし。Secure Enclave署名の既存テストに加え、App Attestの保存・再起動、一時障害、invalidKey、428からの回復を検証。
- SimulatorのDeviceCheck対応判定で一度クラッシュしたため、未対応のSimulatorではAPIを呼ばない分岐を加えた（[Tweetbot #397](https://github.com/twitter-studio/tweetbot/issues/397)）。回避後の全715件が成功。
- 独立したコードレビューとセキュリティレビューの指摘を修正して再確認済み。合成CA・鍵による検証であり、Apple実機との互換性の証明ではない。

## 承認後の実行状況

オーナーがAppleのcapability・自動署名更新、既存sandbox D1へのmigrationとWorker更新、招待制を維持した実機検証を承認した。今回のCLI配置もGitHub Environment経由の規則への例外として承認済み。

1. Team `PU5HXZ4FZ2` / `com.twitter-studio.Tweetbot` のApp ID prefixとApp Attest capabilityを確認する。必要なcapabilityを有効にし、Automatic signingで開発用プロファイルを更新する。手動署名へ切り替えない。
2. 開発用の実機ビルドの署名済みentitlementにApp Attestの`development`が入ることを確認し、iPhone 16へインストールする。
3. **完了**。既存sandboxのD1 `notification-service`へ生成済み`0001_low_whirlwind.sql`を適用し、PR #42のWorkerを既存の`notification-service`へ配置する。新しい表を追加するmigrationであり、親表の再作成や既存行の書き換えはない。
4. **完了**。`APP_ATTEST_POLICY`を`invite_only`・開発環境のままにし、実機ビルドのCFBundleVersionを許可リストへ合わせる。新しいCloudflareリソースや秘密は追加しない。receiptは既存の暗号鍵束を使う。
5. 実機で初回証明・既存pending登録の昇格、次のassertionによるセッション更新を確かめる。認証情報やApple応答をログや証拠の文書へ出さず、HTTP結果・attestation_state・counterの増加だけを記録する。検証用の公開鍵等を扱う必要があれば、Git外の保護した場所だけに置く。
6. 実機とAPIの検証、GitHub側レビュー・CIを終えた後、両PRをReadyにしてsquash mergeする。#15の未完了条件を確認して更新する。

対象は[service PR #42](https://github.com/twitter-studio/notification-service/pull/42)と[Tweetbot PR #396](https://github.com/twitter-studio/tweetbot/pull/396)。現在は両方Draft。コードのGitHub再レビューはserviceのa338b4eとiOSの814b8aeで指摘なし。

## 配置結果と現在の停止点

- D1 `0001_low_whirlwind.sql`適用成功（3コマンド）。`installation_attestations`の存在と外部キー違反0件を確認。
- 稼働Worker version: `0998fcc6-8e09-4216-9198-6d5d7b86e2ed`。通常のQueue・Cronを保持し、新しいリソースは作成していない。
- healthは200で期待する固定応答、未認証の`GET /v1/settings`は401・no-store。招待制・development・bundle version `1`を維持。
- D1の集計は既存pendingのinstallationが1件、App Attestの行は0件。実機で確認済みになった証拠はまだない。
- XcodeMCPKitの実機ビルドは`No Accounts`と、現行の自動署名プロファイルにApp Attest capability / entitlementがないエラーで失敗。代替Xcode MCPも`Transport closed`で利用できなかった。XcodeMCPKit自体が原因とは確定していない。
- Apple DeveloperのTeam `PU5HXZ4FZ2`と対象Bundle IDの存在は画面で確認したが、App ID prefixの照合とcapabilityの保存は未完了。ブラウザ操作がタイムアウトしたため変更済みとは扱わない。
- オーナーが再サインインした後、Xcode 27.3 betaのGUIで対象アカウント・Developer Team・Certificates, Identifiers & Profilesへのアクセスを確認した。しかし所有workspaceを閉じてproxy/helperを再起動してもheadlessはNo Accountsのまま。外部MCPアクセス設定はAlwaysで、公式mcpbridgeも初期化後に接続が閉じた。27.2はこのMacに残っておらず比較未実施。原因をXcodeMCPKit固有と断定せず、[Tweetbot #398](https://github.com/twitter-studio/tweetbot/issues/398)に記録した。
- 一度だけ通常のXcodeでAutomatically manage signingを維持したiPhone 16向けBuildをオーナーへ依頼した。GUIで自動プロファイルを更新できるか確認後、headlessと実機検証へ戻る。Appleの認証情報や確認コードは取得せず、手動署名へは切り替えていない。

## 今回の範囲に含めないもの

productionへの配置・鍵の発行・App Attest必須化、招待制の解除、Xとの接続、fraud metricの取得、DeviceCheck用の秘密の発行、プラン変更、新規の有料リソース。今回のCLI配置は、共通AGENTS.mdのGitHub Environment経由の規則に対する今回限りの例外承認で実行した。
