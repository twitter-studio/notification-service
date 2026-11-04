# notification-service — エージェントの規則

この前半は、組織の共通の規則 (`twitter-studio/.github/AGENTS.md`、commit 47af325) の写し。後半の「このリポジトリ」が、このリポジトリ固有の規則。

この規則の正本は `twitter-studio/.github/AGENTS.md`。各リポジトリの `AGENTS.md` には、この規則の写しと、そのリポジトリ固有の規則と検証のコマンドを置く (下の「各リポジトリに写すもの」)。リンクだけで引き継いだとみなさない。リポジトリ固有の規則がこの規則と違うときは、リポジトリ固有の規則に、違う理由と一緒に書く。

## 目的と構成

- `tweetbot`: iOS のアプリ。裏の WKWebView で x.com を動かし、取ったデータを SwiftUI で出す (公式の X の API は使わない)。アプリ固有の規則は `tweetbot/AGENTS.md`。
- `notification-service`: 運営の通知の中継 API (Hono / Cloudflare Workers / D1 / APNs)。
- `notification-worker`: 利用者が自分の Cloudflare に置く Worker のひな形。X のイベントを中継の API へ送る。
- `notification-docs`: ADR、設計書、セットアップと運用の手順書。

通知の仕組みの設計は `notification-docs/docs/design/` の設計書が正本。運営は X の API の資格情報を集めず、X の契約も持たない。

## 実装の流れ

1. Issue の受け入れ条件、依存関係、関連する PR と ADR を読み、重なりと妨げを確かめる。
2. 外部のサービス (Cloudflare、Apple の APNs、X、パッケージ) の振る舞いは、推測せず、今の公式の文書で確かめる。確かめられないものは、確かめていないと書く。
3. 実装する。実装したら、別のコンテキストのレビュー担当 (エージェント) にレビューさせる。実装者が読み直すだけで済ませない。
4. 認証、トークン、APNs、Webhook、個人情報に関わる変更は、セキュリティのレビューも別に受ける。
5. 指摘はコードで確かめてから直す。採らない指摘は理由を残す。実際にビルドとテストを動かす。AI のレビューだけで合格にしない。
6. 設計を変えたら、ADR、OpenAPI、手順書、Issue の依存関係も一緒に直す。
7. PR に、変えたこと、実行したコマンドと結果、レビューの結果、届いていないゲート、残るリスクを書く。動かしていないチェックを通ったと書かない。

## 記述の責務

- **コードには How**: 実装の方法を、コードの構造、名前、処理で表す。
- **テストコードには What**: 期待する振る舞いと、保証する結果を書く。
- **コミットログには Why**: 変更が要る理由と、解決する問題を書く。
- **コードコメントには Why not**: ほかの案を採らない理由と、守る制約を書く。

## ワークアラウンドの追跡

OS、ライブラリ、外部のサービスの不具合や制約をワークアラウンドで避けたときは、Issue に残す (何を避けたか、どう避けたか、外せる条件)。コードのコメントにも Issue の番号を書く。恒久的な設計や妥当な設定を、ワークアラウンドとして扱わない。

## セキュリティ

- 秘密を、コード、設定のファイル (`wrangler.jsonc`、`.dev.vars` など)、ドキュメント、URL、GitHub Pages、ログ、Issue、PR、テストのフィクスチャ、スクリーンショットに残さない。値を出力しない。秘密には、APNs の `.p8` の鍵、X の資格情報と Webhook の署名の秘密、中継の資格情報、セッションのトークン、デバイストークン、D1 のデータを暗号化する鍵、Cloudflare の API トークンなどがある (この一覧に限らない)。
- 運営の DB に、X の OAuth のトークン、X の API の鍵、DM の本文、ツイートの本文、要らない X の識別子を置かない。
- 次のことは、オーナーの明示の承認を得てから行う: 課金の発生するリソースを作る、本番やプレビューへデプロイする、本番の DB に migration を当てる、権限を広げる (GitHub、Cloudflare、Apple の権限やトークンの範囲)、X の API のクレジットを買う、X の API を実際のアカウントで使う。実際の X のアカウントで X に残る操作は、各リポジトリの `AGENTS.md` が許した範囲だけで行う (tweetbot ではテスト用の @tacos_sin だけ)。
- デプロイは、保護した GitHub の Environments と、範囲を絞った Cloudflare の資格情報で行う。CodeQL と secret scanning は、使えるリポジトリで有効にする (非公開のリポジトリでは、Free プランでは使えない)。

## GitHub Actions

- 外部の Action と Docker のイメージは、完全な hash で固定し、`# v1.2.3` のように版をコメントに書く。CI の zizmor が、固定、本家の履歴にない commit、版のコメントのずれを調べる。
- `permissions` は最小にし、`actions/checkout` の資格情報を残さない (`persist-credentials: false`)。
- PR の信頼できないコードを `pull_request_target` で動かさない。`${{ github.event.* }}` などの外から入る値を `run:` に直に書かず、`env:` で渡す。`secrets: inherit` を使わない。
- 再利用の Workflow を呼ぶときは、default branch の履歴にある commit の SHA で呼ぶ。
- ツールは版で固定し、中身を確かめられる方法で入れる (`go install …@vX`、PyPI の版の固定など)。

## GitHub の運用

- ブランチは中身に合わせて `feature/`、`fix/`、`chore/`、`docs/` などで切り、`main` へ PR を出す。`main` へ直接 push しない (新しいリポジトリを作ったときの最初の README だけは、GitHub の自動の初期化を使ってよい)。
- PR は squash merge する。PR のタイトルと本文がそのまま `main` のコミットになるので、変更を足したら本文も直す。
- 文書、Issue、PR、コミットは日本語で書く。
- 設計書から作る Issue は、タイトルの頭に設計書の ID を付ける (`[API-001] …`)。どの Issue にも、受け入れ条件と依存関係 (GitHub の issue dependencies) を書く。
- Issue は、`zunda-pixel` の個人の GitHub Project (Project 8) で管理する。組織の Project は作らない。Project の番号や URL は推測せず、実際の Project を確かめてから触る。
- 共通のラベル: `type:feature`、`type:security`、`type:docs`、`type:chore`、`bug`、`status:blocked`、`needs:owner` (オーナーの判断や作業が要る。自動では進めない)、`priority:p0`、`priority:p1`。リポジトリ固有のラベル (tweetbot の `workaround` など) は、そのリポジトリの決まりで使う。
- 非公開のリポジトリでは、Free プランの Rulesets、ブランチの保護、CODEOWNERS によるレビューの依頼が効かない。上の決まりは運用で守る。

## GitHub の Codex のレビュー

- 組織に入れた Codex は、PR を開いたとき、Draft から Ready にしたとき、`@codex review` とコメントしたときにレビューする。push では走り直さない。
- レビューが付いたかを確かめ、指摘はコードで確かめてから直し、スレッドに直したコミットか、直さない理由を返す。直したあとに見てもらうときは `@codex review` とコメントし、どの commit を見たかを PR に残す。
- 使用量の上限、未設定、実行の失敗でレビューが付かないときは、指摘なしとみなさず、そのことを PR に書く。この場合は、別のコンテキストのレビュー担当のレビューと、実際のビルドとテストで判断する。

## 各リポジトリに写すもの

組織の `.github` から自動で引き継がれるのは、公開にしたときの Issue と PR のテンプレート、`CONTRIBUTING.md`、`SECURITY.md` などの community health files だけ。次のものは、各リポジトリに写して置く。

- `AGENTS.md`: この規則の写し (写した元の commit を書く) と、リポジトリ固有の規則と検証のコマンド。
- `.github/CODEOWNERS`、`.github/pull_request_template.md`。
- CI (`.github/workflows/`) と `zizmor.yml`、`.github/dependabot.yml` (cooldown をつける)。
- `LICENSE`: Apache License 2.0 (tweetbot と同じ。オーナーの判断)。

共通の規則を変えたら、各リポジトリに追従の PR を出し、写した元の commit を書く。

---

## このリポジトリ (notification-service)

運営の通知の中継 API。設計書の §3〜§5、§7〜§9 が対象。Issue は API-001、DB-001、AUTH-001、API-002、AUTH-002、API-003、APNS-001、APNS-002、QA-001。

### 検証のコマンド

Node.js と pnpm は `mise.toml` で固定している (`mise exec -- pnpm …`、または mise を有効にしたシェル)。

```sh
pnpm install --frozen-lockfile
pnpm lint        # Biome (ADR-0001)
pnpm typecheck   # wrangler types --check と tsc (本番のコードとテストで tsconfig を分けている)
pnpm test        # Vitest。workerd の上で動かす (ADR-0002)
pnpm build       # wrangler deploy --dry-run。デプロイはしない
pnpm --filter @notification-service/api openapi   # 公開の API の OpenAPI の文書 (apps/api/openapi.json) を作り直す
```

### 決まり

- 依存は、公開から 3 日たった版を選ぶ (`pnpm-workspace.yaml` の `minimumReleaseAge`。Dependabot の cooldown とそろえている)。例外 (`minimumReleaseAgeExclude`) を足さない。インストール時のスクリプトは動かさない (`allowBuilds` で false)。要るものが出たら、理由と一緒に true にする。
- 手元の秘密は `apps/api/.dev.vars` (コミットしない) に置き、名前だけを `apps/api/.dev.vars.example` に書く。型 (`worker-configuration.d.ts`) は `.dev.vars.example` から作る (`pnpm --filter @notification-service/api types`)。`wrangler.jsonc` か `.dev.vars.example` を変えたら作り直す (CI が `--check` で調べる)。
- wrangler と `@cloudflare/*` は、Dependabot が 1 つの PR にまとめる。その PR は型の版が変わるので `typecheck` で落ちる。PR のブランチで `types` を動かし、型を作り直して push する。`compatibility_date` は、`@cloudflare/vitest-plugin` に付く workerd が対応する日付より新しくしない (ADR-0002)。
- Node.js の版は `mise.toml` と `.github/workflows/ci.yml` の 2 か所にある。そろえて上げる (ADR-0003)。
- 公開の API は `@hono/zod-openapi` のスキーマで先に決め、生成したものを手で直さない。入口には `operationId` を付け (アプリの Swift のクライアントのメソッドの名前になる)、セッションや中継の資格情報の要る入口には `security` を書く。API を変えたら `apps/api/openapi.json` を作り直す (テストが、作った文書と比べる。アプリのクライアントは、このファイルから作る。IOS-002)。エラーの応答は `src/problem.ts` の problem+json にし、`request_id` はサーバーで作る。エラーの文は応答にもログにも出さない。
- APNs のデバイストークンは、`src/security/device-token.ts` の `sealDeviceToken` で、端末の行に結び付けて暗号化し、版の付いた指紋 (HMAC) と一緒に DB に置く (ADR-0005)。DB の関数はブランドの型で受け、DB も形を CHECK で確かめる。鍵は確かめの値 (`DEVICE_TOKEN_KEY_CHECKS`、`scripts/key-check.mjs` で作る) と比べてから使う。暗号化の鍵の入れ替えは 2 段で行い (足してから current にする)、古い鍵は古い暗号文がなくなるまで残す。指紋の鍵は入れ替えない。トークン、鍵、暗号文、指紋は、ログにもエラーの文にも出さない。
- 登録とセッションの約束事 (チャレンジ、端末の鍵の署名、トークン) は ADR-0006、中継の資格情報の入れ替えと取り消しは ADR-0007、端末の登録とトークンを持っていることの確かめは ADR-0008、中継の受け付けと端末へ送る流れは ADR-0009、使われなくなったアカウントを消すのは ADR-0010。試作のあいだは、招待のコード (`ENROLLMENT_INVITE_CODE`) がないと登録できない。App Attest を確かめるまで (AUTH-003) この制限を外さない。
- 型の付いた入口 (zod-openapi) からは、宣言した成功の応答だけを返し、失敗は `ProblemError` を投げる (app.ts の onError が problem+json にする)。アカウントのセッションが要る入口には、`createRoute` の `middleware` に `requireSession` を置く (`c.get("session")` は、置いた入口でだけ型に出る。`app.use` で付けると型に出ない)。中継の資格情報で送る入口には `requireRelayCredential` を置く (ADR-0007)。
- 名前を名乗らない入口や、D1 に書く入口には、回数の制限 (`enforceRateLimit`、Workers の Rate Limiting) を付ける。制限の数は `wrangler.jsonc` の `ratelimits` に置く。
- 公開鍵、署名、MAC などのバイト列は、`fromBase64Url` で読む (書き方を 1 つに決め、`=` や使わないビットの違う書き方を受けない)。
- `observability` のログにはリクエストのヘッダーも残る。秘密を独自のヘッダーで受けるときは、ログに残らないかを確かめる。
- `wrangler deploy` を `--dry-run` なしで動かさない (デプロイはオーナーの承認を得てから)。Cloudflare の資格情報と秘密は、このリポジトリに置かない。
- `GET /health` などの公開の応答に、版、設定、秘密の有無を出さない。
- D1 のスキーマは `packages/db/src/schema.ts` に書き、migration は `pnpm --filter @notification-service/db generate` (drizzle-kit) で作る。作った SQL を手で直さない。例外は、親の表を作り直す migration だけ。drizzle-kit が出す `PRAGMA foreign_keys` は D1 で効かないので、先頭に `PRAGMA defer_foreign_keys = on`、末尾に `PRAGMA defer_foreign_keys = off` を置き、途中の `PRAGMA foreign_keys` の行はすべて消す (off は末尾だけ。途中に置くと、そのあとの作り直しで失敗する。ADR-0004)。末尾の off は本当の違反も数えなくするので、`migrations.test.ts` が `PRAGMA foreign_key_check` で、親のない子の行がないことを確かめる。外部キーは CASCADE にしない (表を作り直すと、子の行が消える)。データの入った D1 に migration を当てても行が残ることは、`migrations.test.ts` で確かめる。CI が、schema.ts と migration のずれを調べる。本番の D1 に migration を当てるのは、オーナーの承認を得てから。
- DB の時刻は、UNIX 時間のミリ秒の整数で持つ (ADR-0004)。生の SQL で `CURRENT_TIMESTAMP` などの文字列の時刻と比べない。
- DB の読み書きは、アカウントをまたがないよう、条件にアカウントを入れる。テストで、ほかのアカウントに触れないことを確かめる。例外は、アカウントを決めるための読み (`findActiveRelayCredential`。資格情報のハッシュでアカウントが決まる)、サーバーが選んだ端末への APNs の応答 (`invalidateDevice`。トークンの指紋も合わせる)、確かめで、同じトークンを確かめていたほかの行の確かめを外すこと (`markDeviceVerified`。確かめた側が自分のアカウントの有効なインストールのときだけ)、定期の掃除 (`deleteAcceptedEventsBefore`、`deleteStaleDevices`、`findAbandonedAccounts` など) だけ。
- テストの D1 は、同じファイルのテストどうしで空にならない。ID、ハッシュ、トークンはテストごとに違う値 (`unique()`) にし、ほかのテストの行に頼らない。
- テストは各 app の `test/` に置く (`apps/api/test/` と `apps/apns-probe/test/`)。設計書 §7 の `tests/{unit,…}` は、workspace に合わせてパッケージの中に置いた。Node.js で実行する運用スクリプトだけは、同じ実行環境の `node --test` で検証する。
