# ADR-0014: App Attestによる登録とセッション更新

Status: Accepted / 2026-11-04（実機互換性と配置は未検証）

## 背景

AUTH-003は、招待コードだけで受け付けていた登録にAppleの検証結果を結び付ける。Secure Enclaveのインストール鍵は維持し、App Attestの鍵で同じ要求を証明する。確認済みの登録を招待コードだけの認証へ戻さない。

## 決定

- 登録・セッション更新の`app_attest`は、`kind`（attestation / assertion）、32バイトの`key_id`、CBORの`data`を持つ。バイト列は既存の正規Base64URLで送る。clientDataはADR-0006の署名対象のUTF-8、Appleへ渡すclientDataHashはそのSHA-256。同じチャレンジ・用途・インストール鍵またはIDへ両方の証明を結び付ける。
- CBORはcborg、ASN.1・X.509・CMSはPKI.js / ASN1.js、暗号処理はWorkersのWebCryptoを使う。公開から3日以上経過した版に固定する。AppleのApp Attestation RootとApple Root CA G3はコードに公開の定数として固定し、要求や環境変数からtrust anchorを受けない。検証中にAIA・OCSP等の外部URLを取得しない。
- attestationの証明書の署名・有効期間・CA制約・固定rootまでの鎖、nonce拡張、P-256公開鍵、key ID、credential ID、COSE鍵を照合する。RP ID、初回counter=0、AAGUID、配布区分とbundle versionも検証する。開発はcategory 3、productionはTestFlightの2とApp Storeの4だけ。Enterprise / ad-hoc等は受けない。
- receiptは別にCMS署名とApple Root CA G3までの鎖を検証し、App ID・attested key・ATTEST・生成から5分以内（未来の許容は1分）を照合する。署名証明書はApple公開例のApp Attest receipt用OID `1.2.840.113635.100.12.15`を必要とする。これは署名用途を限定するサービスのポリシーであり、Apple公開例から推定した条件。実機で確認する。
- 初回の検証結果は`installation_attestations`に保存し、`installations.attestation_state=verified`にする。key IDは全インストールで一意。receiptは`DEVICE_TOKEN_KEYS`の現行AES-GCM鍵で、独立した用途名・形式`ar1`・暗号鍵ID・App Attest key IDをAADとして暗号化する。平文・暗号文・鍵ID・証明書・key IDをログへ出さない。
- 鍵のローテーションではAPNsトークンだけでなくreceiptの`ar1.<鍵ID>.`の行も数える。古いreceiptが残るあいだ古い暗号鍵を削除しない。receiptを別用途・別key IDへコピーして復号できない。アカウントの明示削除と180日未使用の削除でreceiptの行も消す。取り消し済みinstallationの行は従来の保持期間まで残す。
- 確認済みの登録では再登録とセッション更新に同じApp Attest鍵のassertionを必要とする。RP ID・版・配布区分・署名・増加counterを検証し、D1の同じバッチでチャレンジ消費、counterの比較交換、セッション作成を行う。counter更新の直後の`changes()=1`でセッション作成を限定する。同じcounterの競合は1件だけ成功する。初回昇格時には古い未確認セッションを削除する。
- App Attest鍵がinvalidKeyとなった場合は、新しい鍵の初回attestationと既存のインストール鍵の署名で置き換える。新しいkey IDを必要とし、旧key IDのCAS、receipt更新、counter=0、旧セッション破棄を同じバッチで行う。App Attestの検証省略や招待コードだけの鍵置換は許さない。
- 確認済みの登録の再登録は既存installationだけを更新する。読み取り後に削除が競合しても、assertionだけで新しいpending登録を作らない。
- 初回attestationが必要な登録、または保存済みkey IDと異なる鍵のassertionが来たら、インストール鍵の署名を検証した後に428を返す。App Attestが成功した後に通信が切れても、クライアントはまず同じ鍵のassertionで回復を試し、サーバーに未登録と確認できた場合に限り初回attestationをやり直せる。
- 登録の本文だけ96KiB、セッション更新だけ16KiBに上限を広げ、他のAPIは4KiBを維持する。復号後のattestationは64KiB、assertionは8KiBまで。入力の詳細を含まない固定エラーを返す。

## 開発・未対応環境と切り替え

`APP_ATTEST_POLICY`はmode、appId、environment、bundleVersionsの明示した許可リストを持つ。不正な設定では処理を閉じる。

- `invite_only`：sandbox導入中の設定。登録には有効な招待コードも必要。証明を提供できないSimulator等はpendingのまま登録できる。提供した証明が不正なら招待コードへfallbackしない。確認済みの登録は証明を省略できない。
- `required`：公開時の設定。招待コードを必要とせず、検証済みの登録だけを受ける。Simulator・App Attest未対応端末・Apple障害は登録を拒否する。既存pendingのbearerも拒否し、初回証明を付けたセッション更新で昇格させる。`not_supported`というクライアント申告を信頼しない。
- environmentを跨いで鍵を使わない。App ID prefixはTeam IDと同一とは限らないため、Apple Developerの対象IDで照合する。現在の候補は`PU5HXZ4FZ2.com.twitter-studio.Tweetbot`。開発・productionの許可版はリリース手順で管理する。
- iOSはApp Attestのkey IDをThisDeviceOnlyのKeychainでインストール鍵と一緒に保存する。要求を直列化し、assertionの生成・送信順序を保つ。AppleのserverUnavailableでは同じ鍵とclientDataHashを再試行する。鍵の作り直しを要求のたびに行わない。再インストールは新しいidentityとする。
- fraud metricの取得・refreshは含めない。Appleへreceiptを送る処理とDeviceCheckの署名秘密は別の運用判断とする。現行のtopic限定APNs鍵を流用しない。

## 検証と配置のゲート

合成CA・鍵をその場で生成し、実際の証明書署名・CMS署名・assertion署名をworkerdで検証する。偽CA、改ざん、challenge・App ID・環境・版の不一致、期限切れ、counter再利用、同時更新とアカウント削除を検証する。合成fixtureはApple実機との互換性の証拠にしない。

実機で初回attestationと次のassertionを確認するまで招待制を外さない。最新のApple資料の拡張名・receiptの鍵フィールド・署名用途の実形式もその際に照合する。Appleのcapability・プロファイル変更、D1 migrationとWorker配置はオーナーの承認後に行う。自動署名を維持する。production切り替えは別に承認を得る。

## 参照（2026-11-04確認）

- [Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
- [Establishing your app’s integrity](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity)
- [Assessing fraud risk](https://developer.apple.com/documentation/devicecheck/assessing-fraud-risk)
- [Attestation object validation guide](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide)
- [Apple Private PKI](https://www.apple.com/certificateauthority/private/)
