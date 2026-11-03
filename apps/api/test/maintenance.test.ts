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

it("定期の掃除は、残す期間より古い受け付けの記録だけを消す", async () => {
  const db = createDb(env.DB);
  const account = await enrollInstallation(db, {
    publicKey: `key-${crypto.randomUUID()}`,
    relaySecretHash: `hash-${crypto.randomUUID()}`,
  });
  const scheduledTime = Date.parse("2026-11-10T03:17:00.000Z");
  await acceptEventOnce(
    db,
    { accountId: account.accountId, eventId: "old" },
    new Date(scheduledTime - ACCEPTED_EVENT_RETENTION_MS - 1),
  );
  await acceptEventOnce(
    db,
    { accountId: account.accountId, eventId: "kept" },
    new Date(scheduledTime - ACCEPTED_EVENT_RETENTION_MS + 1),
  );

  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime, cron: "17 3 * * *" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  expect(await acceptEventOnce(db, { accountId: account.accountId, eventId: "old" })).toBe(true);
  expect(await acceptEventOnce(db, { accountId: account.accountId, eventId: "kept" })).toBe(false);
});
