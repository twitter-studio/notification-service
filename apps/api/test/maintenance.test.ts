import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ABANDONED_ACCOUNT_AFTER_MS,
  beginEvent,
  completeEvent,
  createDb,
  createSession,
  type DeviceTokenCiphertext,
  type DeviceTokenFingerprint,
  enrollInstallation,
  registerDeviceToken,
} from "@notification-service/db";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  ACCEPTED_EVENT_RETENTION_MS,
  cleanupAbandonedAccounts,
  cleanupAcceptedEvents,
  cleanupExpiredAuthRecords,
  cleanupStaleDevices,
  INVALIDATED_DEVICE_RETENTION_MS,
  REVOKED_RELAY_CREDENTIAL_RETENTION_MS,
} from "../src/maintenance";
import { CLOCK_SKEW_MS } from "../src/security/challenge";

/** wrangler.jsonc の triggers.crons と同じ式。 */
const CLEANUP_CRON = "17,27,37,47 18 * * *";

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
    createScheduledController({ scheduledTime, cron: CLEANUP_CRON }),
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

it("APNs が無効と返してから期間を過ぎた端末を、定期の掃除で消す", async () => {
  const account = await newAccount();
  const scheduledTime = Date.parse("2026-11-10T18:17:00.000Z");
  const db = createDb(env.DB);
  const fingerprint = `f1.stale-${crypto.randomUUID()}`;
  const registered = await registerDeviceToken(db, {
    accountId: account.accountId,
    installationId: account.installationId,
    apnsTokenCiphertext: `v1.test.${crypto.randomUUID()}` as DeviceTokenCiphertext,
    tokenFingerprint: fingerprint as DeviceTokenFingerprint,
    apnsEnvironment: "sandbox",
    topic: "com.twitter-studio.Tweetbot",
    challenge: { nonce: `nonce-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) },
  });
  if (registered.kind !== "registered") throw new Error("device was not registered");
  await env.DB.prepare("UPDATE devices SET state = 'invalidated', updated_at = ? WHERE id = ?")
    .bind(scheduledTime - INVALIDATED_DEVICE_RETENTION_MS - 1, registered.deviceId)
    .run();

  const result = await cleanupStaleDevices(env, scheduledTime);

  expect(result.deleted).toBeGreaterThanOrEqual(1);
  expect(
    await env.DB.prepare("SELECT id FROM devices WHERE token_fingerprint = ?")
      .bind(fingerprint)
      .first(),
  ).toBeNull();
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
    createScheduledController({
      scheduledTime: Date.parse("2026-11-10T18:17:00.000Z"),
      cron: CLEANUP_CRON,
    }),
    broken,
    ctx,
  );

  await expect(waitOnExecutionContext(ctx)).rejects.toThrow(/^cleanup_failed$/);
});

it("定期の掃除で、使われなくなったアカウントを消し、最近使ったアカウントは残す", async () => {
  const scheduledTime = Date.now();
  const abandoned = await newAccount();
  const active = await newAccount();
  await env.DB.prepare("UPDATE installations SET last_used_at = ? WHERE id = ?")
    .bind(scheduledTime - ABANDONED_ACCOUNT_AFTER_MS - 1, abandoned.installationId)
    .run();

  const result = await cleanupAbandonedAccounts(env, scheduledTime);

  expect(result.deleted).toBeGreaterThanOrEqual(1);
  const states = await env.DB.prepare(
    "SELECT id, state FROM notification_accounts WHERE id IN (?, ?) ORDER BY id",
  )
    .bind(abandoned.accountId, active.accountId)
    .all<{ id: string; state: string }>();
  expect(Object.fromEntries(states.results.map((row) => [row.id, row.state]))).toEqual({
    [abandoned.accountId]: "deleted",
    [active.accountId]: "active",
  });
});

it("Cron の発火した分ごとに、決まった掃除だけを動かす。知らない式と分は失敗にする", async () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const [minute, name] of [
    [17, "accepted_events"],
    [27, "auth_records"],
    [37, "stale_devices"],
    [47, "abandoned_accounts"],
  ] as const) {
    logs.mockClear();
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.UTC(2026, 10, 4, 18, minute),
        cron: CLEANUP_CRON,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const logged = logs.mock.calls.map(
      (call) => JSON.parse(String(call[0])) as { cleanup?: string },
    );
    expect(logged.map((entry) => entry.cleanup)).toEqual([name]);
  }
  logs.mockRestore();

  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [cron, minute] of [
    ["0 0 * * *", 17],
    [CLEANUP_CRON, 18],
  ] as const) {
    await expect(
      worker.scheduled(
        createScheduledController({ scheduledTime: Date.UTC(2026, 10, 4, 18, minute), cron }),
        env,
        createExecutionContext(),
      ),
    ).rejects.toThrow(/unknown_cron/);
  }
  errors.mockRestore();
});

it("使われなくなったアカウントの掃除は、1 つのアカウントで失敗しても、次のアカウントへ進み、上限まで消したら知らせる", async () => {
  const scheduledTime = Date.now();
  const accounts = [await newAccount(), await newAccount(), await newAccount()];
  for (const account of accounts) {
    await env.DB.prepare("UPDATE installations SET last_used_at = ? WHERE id = ?")
      .bind(scheduledTime - ABANDONED_ACCOUNT_AFTER_MS - 1, account.installationId)
      .run();
  }
  let failures = 1;
  const flaky = new Proxy(env.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (failures-- > 0) throw new Error("D1_ERROR: injected failure");
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await cleanupAbandonedAccounts({ ...env, DB: flaky }, scheduledTime, {
    pageSize: 2,
    maxAccounts: 2,
  });

  expect(result.capped).toBe(true);
  expect(result.deleted).toBe(1);
  expect(JSON.stringify(errors.mock.calls)).toContain("abandoned_account_cleanup_failed");
  expect(JSON.stringify(errors.mock.calls)).not.toContain("injected failure");
  errors.mockRestore();

  const rest = await cleanupAbandonedAccounts(env, scheduledTime);
  expect(rest.capped).toBe(false);
});
