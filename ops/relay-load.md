# sandboxの通常中継を上限付きで検証する

## 実行前

1. オーナーから対象・件数・費用の承認を得る。
2. 既存のsandboxで招待制development、Xと模擬Webhookの無効、両Queueが空であることを確認する。試験中は端末登録・配信設定・配置を変更しない。
3. 資格情報が試験用アカウントの現行のものであることと、そのアカウントの配送可能な宛先が承認済みのiPhone 1台だけであることを読み取りで照合する。配信を伴う別の作業を同時に実行しない。
4. 現行のCloudflare契約、含有枠、利用量、D1の件数を確認する。追加費用の見込みが1 USDを超える場合や、必要な読み取り権限・配信件数を確認できない場合は中止する。試験時刻より前のWorker・D1・Queue・ログ使用量を記録する。

## 1回だけ実行する

運営Workerの `POST /v1/notifications` を呼ぶ。中継資格情報を保護ファイルに置き、台帳には同じ保護ディレクトリ内の新しいファイルを指定する。

```sh
mise exec -- node apps/api/scripts/relay-load.mjs --execute-sandbox \
  /path/to/private/relay-token.txt /path/to/private/relay-load.jsonl
```

- 空JSON 1件の拒否、合成イベント1件の受理、同じイベント1件の重複を順に確認する。その後、同じイベントを2件ずつ30組、各組の前に5秒待って送る。計63要求、並列2、スクリプトの制限時間は6分。
- 期待した応答以外を受けたら、進行中の組を集計して止まる。429や通信エラーで送り直さない。中断や異常後に別の台帳で再実行するには、先に運営側の処理とQueueを確認して再承認を得る。
- 新規イベントは1件。1宛先なら通常はAPNs初回1件、一時障害時は同じQueueジョブの再送が最大2回。Queueは少なくとも1回の配信であり、障害時の再配信や並行する別通信まで含む外部の件数は、スクリプトのHTTP上限とは別に監視する。
- 台帳には時刻、送信前に予約した要求数、HTTPステータス、判定、サーバー発行の要求IDを記録する。中断時の予約済み要求は、応答がなくても送信された可能性があるとして扱う。台帳を公開資料へ添付しない。

## 照合する

1. 台帳を運営Workerの `http_request`、`notification_accepted`、`relay_delivered` と照合する。期待値は受理1件、重複61件、入力拒否1件。受理はAPNs成功と別に数える。
2. 同じ時間窓のAPNs応答・再送・滞留を確認する。再送があれば、追加要求を送らず、終了またはジョブの1時間の有効期限まで追う。異常や上限に達するおそれがあれば試験を中止し、運用手順に沿って扱う。Queueを一括削除しない。
3. Worker requestとCPU、D1 rows read/write、Queue operations、ログ量を同じ時間窓で集計し、Cloudflareの料金と照合する。Cronや共有アカウントの別通信が混ざる指標は、その範囲と粒度を併記する。端末に表示された件数はAPNsの応答と分けて記録する。
4. Xと模擬Webhookの無効、両Queueが空、監視が稼働中であることを確認する。合成イベントの重複排除レコードは通常の保持期限で失効する。記録するのは件数・上限・判定に絞る。

[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/) · [D1料金](https://developers.cloudflare.com/d1/platform/pricing/) · [Queues料金](https://developers.cloudflare.com/queues/platform/pricing/) · [Queuesの配信保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
