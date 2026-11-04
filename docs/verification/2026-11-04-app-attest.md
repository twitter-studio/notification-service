# AUTH-003の検証記録

2026-11-04。Issue: [notification-service#15](https://github.com/twitter-studio/notification-service/issues/15)。設計は[ADR-0014](../adr/0014-app-attest.md)。対象は[service PR #42](https://github.com/twitter-studio/notification-service/pull/42)と[Tweetbot PR #396](https://github.com/twitter-studio/tweetbot/pull/396)。

## 自動検証とレビュー

- API: lint、typecheck、workerd 330件、probe 14件、Node運用スクリプト9件、dry-run buildが成功。
- D1: 通常・QAの両Drizzle構成で再生成差分なし。初回登録、pendingからの昇格、counterの同時更新、アカウント削除競合、鍵置換と送信前切断からの回復を検証。
- iOS: XcodeMCPKitでビルドし、715件がすべて成功。失敗・未実行・最終ビルドの警告なし。保存・再起動、一時障害、期限切れ、invalidKey、428からの回復を検証。日本語・英語の登録画面も確認。
- SimulatorのDeviceCheck対応判定のクラッシュは、未対応環境でAPIを呼ばない分岐で回避（[Tweetbot #397](https://github.com/twitter-studio/tweetbot/issues/397)）。実機の対応判定は維持。
- 独立したコードレビューとセキュリティレビューの指摘を修正し、最終のflags・nonce・診断ログの変更にも指摘なし。GitHub CodexはiOS 814b8aeの再レビューで指摘なし。serviceの最新差分はPRに再レビューを依頼する。

## 承認した範囲と配置

オーナーがAppleのcapability・自動署名更新、既存sandbox D1へのmigrationとWorker更新、招待制を維持した実機検証を承認した。CLI配置は今回限りのGitHub Environment経由の規則の例外として承認済み。

- 既存D1 `notification-service`へ生成済み`0001_low_whirlwind.sql`を適用成功。追加表の存在と外部キー違反0件を確認。
- Worker version: `d195a5ce-c379-4a1d-be27-1dd209e9fbce`。既存のQueue・Cron・5 secretを保持。新しいリソース・秘密を作っていない。
- health 200、未認証`GET /v1/settings`は401・no-store。`APP_ATTEST_POLICY`は`invite_only`、development、bundle version `1`を維持。

## 自動署名と実機

Xcode 27.3のGUIではApple AccountとTeamを認識したが、headlessは`No Accounts`、代替公式MCPは`Transport closed`となった。オーナーが通常画面でAutomatically manage signingのまま実機ビルドすると成功し、その後はXcodeMCPKitのheadlessビルドも成功した。手動署名へ切り替えていない。原因をXcodeMCPKit固有と断定せず、[Tweetbot #398](https://github.com/twitter-studio/tweetbot/issues/398)に観測と回復手順を残した。

署名済みentitlementのApp Attestは`development`、application identifierは`PU5HXZ4FZ2.com.twitter-studio.Tweetbot`。自動のiOS Team Provisioning Profile、CFBundleVersion `1`を確認し、最新iOSソース814b8aeをiPhone 16 / iOS 27.3へインストール・起動した。

- 既存pending登録が初回attestationで`verified`へ昇格し、App Attestのcounter `0`の行が1件できた。Appleの証明書の鎖、nonce、鍵、receiptの署名・用途、App ID・版・配布区分が検証を通った。
- 同じインストールのセッションを期限切れにした後、実機のassertionで新しい有効セッション1件を取得し、counterが`0 → 6`へ増加。失敗した試行でも端末側counterは増えるため、連番である必要はない。アプリ画面の通知は「オン」。アカウント、relay資格情報、App Attest鍵を削除せず確認した。
- receiptは`ar1`暗号文の形式で保存されていることを集計で確認。値、証明書、署名、key ID、公開鍵、トークンは出力・記録していない。

## 実機で修正した互換性

実機assertionのflagsは`0xc0`で、拡張はoffset 37から始まっていた。RP ID・版・配布区分は一致した。用途別に構造を解析し、対応flags以外を拒否する。拡張の検証は必須のまま。

署名はAppleの手順に従い`SHA256(authenticatorData || SHA256(clientData))`のnonceをECDSA-SHA256へ渡す。合成データを直接渡した検証は実機で失敗したため修正し、旧形式を拒む回帰テストを追加した。[appattest-swift df0d85aの署名検証](https://github.com/zunda-pixel/appattest-swift/blob/df0d85a46f091c4b0affb6d1ee1e9b4cfc75ad1e/Sources/AppAttest/VerifyAssertion.swift)と[assertion構造](https://github.com/zunda-pixel/appattest-swift/blob/df0d85a46f091c4b0affb6d1ee1e9b4cfc75ad1e/Sources/AppAttest/Assertion.swift)とも照合した。最終構成で実機の署名検証とcounter更新が成功した。

調査用のflags・一致判定ログは除去し、最終コードは固定の拒否段階だけを記録する。入力や例外をログへ出さないことをcanaryで検証。

## 今回の範囲に含めないもの

productionへの配置・鍵の発行・App Attest必須化、招待制の解除、Xとの接続、fraud metricの取得、DeviceCheck用の秘密の発行、プラン変更、新規の有料リソース。`required`へ切り替えるコードと拒否テストは実装済みだが、実際の切り替えは別途オーナーの承認を必要とする。
