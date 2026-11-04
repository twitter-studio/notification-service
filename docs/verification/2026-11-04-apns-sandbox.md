# APNS-001: Workers から sandbox の APNs への到達確認

2026-11-04、オーナーが承認した一度限りの CLI 配置で検証した。実機への到達を確認できた。HTTP の版は直接取得していないため、以下の事実から HTTP/2 の互換性を判断する。

判定: **GO**。APNS-002 で Workers の直接送信を実装する。

## 実行したもの

- service commit: `914120058dd0a1c6850b5c22e78ea1bd34406a00` ([PR #25](https://github.com/twitter-studio/notification-service/pull/25))。
- iOS commit: `8ba784fd6afff9aaef5e04505e6251096748049e` ([Tweetbot PR #391](https://github.com/twitter-studio/tweetbot/pull/391))。iPhone 16、自動署名の Debug ビルド、sandbox のトークン。通知許可済み。
- Worker: `notification-apns-probe`。Wrangler 4.156.0、Node.js と pnpm は mise の固定版。
- 配置時の version: `f108e898-de1c-4eef-bebe-ec551468d105`。このあと3つの短命の secret を設定して送った。
- APNs の送り先: `api.sandbox.push.apple.com`、topic: `com.twitter-studio.Tweetbot`。
- APNs の鍵は Sandbox・Topic Specific・Tweetbot のみに限定したもの。`.p8` は Mac に残し、ローカルで署名した provider token だけを Worker に設定した。
- 検証窓は10分。自動再試行なし。D1・Cron・X 接続・有料リソースの追加なし。要求・subrequest のログと trace は無効。

再現手順は [検証 Worker の README](../../apps/apns-probe/README.md) と [iOS の回収手順](https://github.com/twitter-studio/tweetbot/blob/main/docs/push-registration.md) にある。今回の CLI 配置の承認を、通常の運営 API の配置や将来の再実行の承認には使わない。

## 観測結果

| 項目                                 | 結果                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| 送信開始                             | 2026-11-04 04:13:30.898 UTC (13:13:30.898 JST)                 |
| APNs status                          | 200                                                            |
| request ID / apns-id                 | `ec3417e1-2d2d-4bd5-8dc6-27566bd77633`                         |
| APNs reason                          | なし                                                           |
| APNs 応答までの経過時間              | 473 ms (Worker 内の計測。CPU 時間や実機到達までの時間ではない) |
| 実機への到達                         | オーナーが iPhone 16 の検証通知を確認                          |
| HTTP の版                            | `Response` では取得できない (`not_exposed`)                    |
| CPU 時間                             | P50 / P99 ともに 5.846 ms (生値5846 µs)                        |
| Workers の要求 / subrequest / エラー | 1 / 1 / 0                                                      |

CPU 時間は、Cloudflare GraphQL Analytics API の `workersInvocationsAdaptive` を使い、`scriptName = notification-apns-probe`、04:13:00〜04:14:00 UTC で取得した。04:13:31 UTC の `success` が1行、要求1件。取得時刻は04:14:03 UTC。P50 と P99 はこの1件を含む集計の値であり、繰り返し測定による性能評価や、通常運用の費用見積もりではない。

単位の追加スキーマ照会は Analytics の budget 制限を受けた。代わりに Cloudflare 公式の Prometheus exporter が同じ quantile をマイクロ秒から秒へ換算している実装で単位を確認した (末尾の根拠)。5846 µs を1000で割り、5.846 ms とした。

## HTTP/2 の判断と制限

Apple の provider API は HTTP/2 と TLS を要求する。実際に配置した Worker が、その sandbox endpoint に直接送って200を受け取り、実機にも届いた。間に別の push サービスや HTTP/1.1 の代替経路はない。この実測を、Workers から APNs への HTTP/2 の接続互換性の根拠にする。一般的な `fetch` の仕様だけから判断したものではない。

HTTP/2 の交渉結果そのものやパケットは観測していない。1回の sandbox 到達確認であり、production の鍵・topic、JWT の長期更新、並行処理、失敗時の再試行、継続的な配信品質は APNS-002 と QA-001 の検証に残る。

## 後片付け

- 測定後、`wrangler delete --config wrangler.jsonc --force` が `Successfully deleted notification-apns-probe` を返した。
- Mac の provider token、検証用 bearer、有効期限、実機トークン、回収 UUID の一時ディレクトリを削除した。端末の回収ファイルも通常起動で削除済み。
- `.p8` は Git 管理外の0700ディレクトリの0600ファイルとして Mac に保管している。
- 他の Worker は変更していない。運営 API はまだ配置していない。

## 根拠

- [Apple: APNs への接続要件](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns)
- [Apple: APNs の JWT](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [Cloudflare: Workers metrics の GraphQL 照会](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [Cloudflare 公式 exporter: CPU quantile のマイクロ秒からの換算](https://github.com/cloudflare/cloudflare-prometheus-exporter/blob/e7ff2ccb9f86cd0ef01cf021c37b75db1448d827/src/cloudflare/client.ts#L627-L637)
