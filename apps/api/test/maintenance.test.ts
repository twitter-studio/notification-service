import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { acceptEventOnce, createDb, enrollInstallation } from "@notification-service/db";
import { expect, it } from "vitest";
import worker from "../src/index";
import { ACCEPTED_EVENT_RETENTION_MS } from "../src/maintenance";

async function newAccount() {
  return enrollInstallation(createDb(env.DB), {
    publicKey: `key-${crypto.randomUUID()}`,
    relaySecretHash: `hash-${crypto.randomUUID()}`,
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
  await acceptEventOnce(db, { accountId: account.accountId, eventId: "old" }, new Date(cutoff - 1));
  await acceptEventOnce(
    db,
    { accountId: account.accountId, eventId: "boundary" },
    new Date(cutoff),
  );

  await runCleanup(scheduledTime);

  expect(await acceptEventOnce(db, { accountId: account.accountId, eventId: "old" })).toBe(true);
  expect(await acceptEventOnce(db, { accountId: account.accountId, eventId: "boundary" })).toBe(
    false,
  );
});

it("消す記録が多くても、件数を区切ってくり返し、全部消す", async () => {
  const account = await newAccount();
  const scheduledTime = Date.parse("2026-12-10T18:17:00.000Z");
  const old = scheduledTime - ACCEPTED_EVENT_RETENTION_MS - 1;
  const inserts = Array.from({ length: 1201 }, (_, i) =>
    env.DB.prepare(
      "INSERT INTO delivery_dedup (account_id, event_id, accepted_at) VALUES (?, ?, ?)",
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
