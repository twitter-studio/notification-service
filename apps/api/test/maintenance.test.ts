import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  beginEvent,
  completeEvent,
  createDb,
  createSession,
  enrollInstallation,
} from "@notification-service/db";
import { expect, it } from "vitest";
import worker from "../src/index";
import {
  ACCEPTED_EVENT_RETENTION_MS,
  cleanupAcceptedEvents,
  cleanupExpiredAuthRecords,
  REVOKED_RELAY_CREDENTIAL_RETENTION_MS,
} from "../src/maintenance";
import { CLOCK_SKEW_MS } from "../src/security/challenge";
import { testHash } from "./db/helpers";

async function newAccount() {
  return enrollInstallation(createDb(env.DB), {
    publicKey: `key-${crypto.randomUUID()}`,
    relaySecretHash: testHash(),
    challenge: { nonce: `nonce-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) },
  });
}

async function runCleanup(scheduledTime: number) {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime, cron: "17 18 * * *" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

it("定期の掃除は、残す期間より古い受け付けの記録だけを消し、ちょうど期限のものは残す", async () => {
  const db = createDb(env.DB);
  const account = await newAccount();
  const scheduledTime = Date.parse("2026-11-10T18:17:00.000Z");
  const cutoff = scheduledTime - ACCEPTED_EVENT_RETENTION_MS;
  const old = { accountId: account.accountId, eventKey: "old" };
  const boundary = { accountId: account.accountId, eventKey: "boundary" };
  for (const [event, at] of [
    [old, cutoff - 1],
    [boundary, cutoff],
  ] as const) {
    const start = await beginEvent(db, event, new Date(at));
    if (start.kind === "accepted") await completeEvent(db, { ...event, leaseId: start.leaseId });
  }

  await runCleanup(scheduledTime);

  expect((await beginEvent(db, old)).kind).toBe("accepted");
  expect((await beginEvent(db, boundary)).kind).toBe("done");
});

it("消す記録が多くても、件数を区切ってくり返し、全部消す", async () => {
  const account = await newAccount();
  const scheduledTime = Date.parse("2026-12-10T18:17:00.000Z");
  const old = scheduledTime - ACCEPTED_EVENT_RETENTION_MS - 1;
  const inserts = Array.from({ length: 1201 }, (_, i) =>
    env.DB.prepare(
      "INSERT INTO delivery_dedup (account_id, event_key, accepted_at) VALUES (?, ?, ?)",
    ).bind(account.accountId, `e${i}`, old),
  );
  await env.DB.batch(inserts);

  await runCleanup(scheduledTime);

  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM delivery_dedup WHERE account_id = ?",
  )
    .bind(account.accountId)
    .first<{ count: number }>();
  expect(row?.count).toBe(0);
});

it("くり返しの上限まで消したら、消し残しがありうることを返し、残りは次の掃除で消す", async () => {
  const account = await newAccount();
  // ほかのテストの記録 (2026 年の時刻) を数えないよう、古い時刻で試す。
  const scheduledTime = Date.parse("2001-01-01T00:00:00.000Z");
  const old = scheduledTime - ACCEPTED_EVENT_RETENTION_MS - 1;
  await env.DB.batch(
    Array.from({ length: 5 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO delivery_dedup (account_id, event_key, accepted_at) VALUES (?, ?, ?)",
      ).bind(account.accountId, `capped-${i}`, old),
    ),
  );
  const limits = { batch: 2, maxBatches: 2 };

  expect(await cleanupAcceptedEvents(env, scheduledTime, limits)).toEqual({
    deleted: 4,
    capped: true,
  });
  expect(await cleanupAcceptedEvents(env, scheduledTime, limits)).toEqual({
    deleted: 1,
    capped: false,
  });
});

it("使ったチャレンジの記録は、期限から時計のずれの幅を過ぎてから消す", async () => {
  const scheduledTime = Date.parse("2001-06-01T00:00:00.000Z");
  const nonces = { recent: `nonce-${crypto.randomUUID()}`, old: `nonce-${crypto.randomUUID()}` };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?, ?)").bind(
      nonces.recent,
      scheduledTime - CLOCK_SKEW_MS + 1,
    ),
    env.DB.prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?, ?)").bind(
      nonces.old,
      scheduledTime - CLOCK_SKEW_MS - 1,
    ),
  ]);

  await cleanupExpiredAuthRecords(env, scheduledTime);

  const remaining = await env.DB.prepare("SELECT nonce FROM used_challenges WHERE nonce IN (?, ?)")
    .bind(nonces.recent, nonces.old)
    .all<{ nonce: string }>();
  expect(remaining.results.map((row) => row.nonce)).toEqual([nonces.recent]);
});

it("チャレンジかセッションのどちらかの表が区切りの件数に届いたら、消し残しがありうることを返す", async () => {
  const db = createDb(env.DB);
  // ほかのテストの記録を数えないよう、さらに古い時刻で試す。
  const past = new Date("1980-01-01T00:00:00.000Z");
  // セッションを作るときに、同じインストールの期限切れのセッションは消えるので、アカウントを分ける。
  for (const account of [await newAccount(), await newAccount()]) {
    await createSession(
      db,
      {
        accountId: account.accountId,
        installationId: account.installationId,
        challenge: { nonce: `nonce-${crypto.randomUUID()}`, expiresAt: past },
        session: { tokenHash: testHash(), expiresAt: past },
      },
      past,
    );
  }
  await env.DB.prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?, ?)")
    .bind(`nonce-${crypto.randomUUID()}`, past.getTime())
    .run();
  const scheduledTime = Date.parse("1990-01-01T00:00:00.000Z");

  // チャレンジ 3 件、セッション 2 件。1 回目は両方とも 2 件ずつ消して、上限に届く。
  expect(await cleanupExpiredAuthRecords(env, scheduledTime, { batch: 2, maxBatches: 1 })).toEqual({
    deleted: 4,
    capped: true,
  });
  // 2 回目は、チャレンジの残りの 1 件だけ。
  expect(await cleanupExpiredAuthRecords(env, scheduledTime, { batch: 2, maxBatches: 1 })).toEqual({
    deleted: 1,
    capped: false,
  });
});

it("取り消してから期間を過ぎた中継の資格情報も消し、区切りの件数に届いたら、消し残しがありうることを返す", async () => {
  const account = await newAccount();
  // テストのファイルごとに D1 は分かれる。このファイルのほかのテストの記録と混ざらない、古い時刻で試す。
  const scheduledTime = Date.parse("1965-01-01T00:00:00.000Z");
  const revokedAt = scheduledTime - REVOKED_RELAY_CREDENTIAL_RETENTION_MS - 1;
  const recentRevokedAt = scheduledTime - REVOKED_RELAY_CREDENTIAL_RETENTION_MS + 1;
  const hashes = [testHash(), testHash(), testHash(), testHash()];
  await env.DB.batch(
    hashes.map((hash, index) =>
      env.DB.prepare(
        "INSERT INTO relay_credentials (id, account_id, secret_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        account.accountId,
        hash,
        revokedAt,
        index === 3 ? recentRevokedAt : revokedAt,
      ),
    ),
  );
  const limits = { batch: 2, maxBatches: 1 };

  expect(await cleanupExpiredAuthRecords(env, scheduledTime, limits)).toEqual({
    deleted: 2,
    capped: true,
  });
  expect(await cleanupExpiredAuthRecords(env, scheduledTime, limits)).toEqual({
    deleted: 1,
    capped: false,
  });
  const remaining = await env.DB.prepare(
    "SELECT secret_hash FROM relay_credentials WHERE account_id = ? AND revoked_at IS NOT NULL",
  )
    .bind(account.accountId)
    .all<{ secret_hash: string }>();
  expect(remaining.results.map((row) => row.secret_hash)).toEqual([hashes[3]]);
});

it("掃除が失敗しても、エラーの文 (D1 の文など) は投げ直さない", async () => {
  const ctx = createExecutionContext();
  const broken = {
    ...env,
    DB: {
      prepare: () => {
        throw new Error("D1_ERROR: secret detail");
      },
    },
  } as unknown as Env;

  await worker.scheduled(
    createScheduledController({ scheduledTime: Date.now(), cron: "17 18 * * *" }),
    broken,
    ctx,
  );

  await expect(waitOnExecutionContext(ctx)).rejects.toThrow(/^cleanup_failed$/);
});
