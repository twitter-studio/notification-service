# AUTH-003の検証と残る実機ゲート

2026-11-04。Issue: [notification-service#15](https://github.com/twitter-studio/notification-service/issues/15)。設計は[ADR-0014](../adr/0014-app-attest.md)。

## 完了した検証

- API: lint、typecheck、workerd 323件、運用スクリプト4件、dry-run buildが成功。probeの既存14件とCLI 5件も成功。
- D1: 通常・QAの両Drizzle構成で再生成差分なし。初回登録、pendingからの昇格、counterの同時更新、アカウント削除競合、鍵置換と送信前切断からの回復を検証。
- iOS: XcodeMCPKitでビルドし、714件がすべて成功。未実行・失敗なし。Secure Enclave署名の既存テストに加え、App Attestの保存・再起動、一時障害、invalidKey、428からの回復を検証。
- 独立したコードレビューとセキュリティレビューの指摘を修正して再確認済み。合成CA・鍵による検証であり、Apple実機との互換性の証明ではない。

## 次の操作（オーナー承認前、未実行）

1. Team `PU5HXZ4FZ2` / `com.twitter-studio.Tweetbot` のApp ID prefixとApp Attest capabilityを確認する。必要なcapabilityを有効にし、Automatic signingで開発用プロファイルを更新する。手動署名へ切り替えない。
2. 開発用の実機ビルドの署名済みentitlementにApp Attestの`development`が入ることを確認し、iPhone 16へインストールする。
3. 既存sandboxのD1 `notification-service`へ生成済み`0001_low_whirlwind.sql`を適用し、PR #42のWorkerを既存の`notification-service`へ配置する。新しい表を追加するmigrationであり、親表の再作成や既存行の書き換えはない。
4. `APP_ATTEST_POLICY`を`invite_only`・開発環境のままにし、実機ビルドのCFBundleVersionを許可リストへ合わせる。新しいCloudflareリソースや秘密は追加しない。receiptは既存の暗号鍵束を使う。
5. 実機で初回証明・既存pending登録の昇格、次のassertionによるセッション更新を確かめる。認証情報やApple応答をログや証拠の文書へ出さず、HTTP結果・attestation_state・counterの増加だけを記録する。検証用の公開鍵等を扱う必要があれば、Git外の保護した場所だけに置く。
6. 実機とAPIの検証、GitHub側レビュー・CIを終えた後、両PRをReadyにしてsquash mergeする。#15の未完了条件を確認して更新する。

対象は[service PR #42](https://github.com/twitter-studio/notification-service/pull/42)と[Tweetbot PR #396](https://github.com/twitter-studio/tweetbot/pull/396)。現在は両方Draft。

## 今回の範囲に含めないもの

productionへの配置・鍵の発行・App Attest必須化、招待制の解除、Xとの接続、fraud metricの取得、DeviceCheck用の秘密の発行、プラン変更、新規の有料リソース。CLIによる配置は共通AGENTS.mdのGitHub Environment経由の規則に対する今回限りの例外承認を必要とする。
