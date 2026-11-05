# ADR-0015 公開版の通知登録と配送を別々に停止する

2026-11-05。[RELEASE-001](https://github.com/twitter-studio/notification-docs/issues/3) の公開候補。実環境で有効にするにはオーナーの承認が必要。

## 背景

App Attestの `required` は共有招待コードなしで登録できる。公開開始前や障害時にこの入口を閉じる必要がある。App Attestのモードを変えると登録だけでなく認証条件も変わる。配送だけを止める場合も、利用者が通知をオフにしたり登録を削除したりできる必要がある。

## 決定

`APP_ATTEST_POLICY` の `mode=required` と `environment=production` の組み合わせに限り、登録と配送にそれぞれ明示の `true` を要求する。

| 変数                        | 対象                                             | `true` 以外                                                                            |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `PUBLIC_ENROLLMENT_ENABLED` | `POST /v1/enrollments`                           | 403。停止中は発行済みのチャレンジを使った要求も拒否する。                              |
| `PUBLIC_DELIVERY_ENABLED`   | 中継、テスト通知、端末の登録・更新、再送consumer | HTTPは503と `Retry-After`。停止中にconsumerが受け取ったジョブは破棄を記録してackする。 |

既存のセッション更新、設定確認、配信オフ、資格情報の取り消し、削除には適用しない。招待制と開発環境は既存の挙動を維持する。スイッチはWorkerの配置単位で反映し、以前の版ですでに始まった処理やAPNs受理済みの通知には効かない。

## 採らなかった案

- 招待secretやApp Attestのポリシーを変更する。登録の停止に認証方式の変更が伴い、確認する範囲が広がる。
- Queueだけをpauseする。HTTP要求からの直接APNs送信が残る。
- 受信を停止しても再送を待機させ続ける。障害前のジョブが再開後に届く。再開時は両側のQueueと資格情報の状態を確認する。

## 公開用の配置

公開用Worker、D1とQueue、App Attestの設定と許可build番号を、検証環境から分離する。公開用の保護Environmentと配置手順の準備後、対象SHAと設定を承認して操作する。初期状態は両方 `false`。運営側・利用者側の停止と再開の確認は、[公開準備](https://github.com/twitter-studio/notification-docs/blob/main/docs/operations/2026-11-05-release-decision.md)に記録する。
