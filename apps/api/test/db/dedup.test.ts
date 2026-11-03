import { env } from "cloudflare:workers";
import {
  beginEvent,
  completeEvent,
  deleteAcceptedEventsBefore,
  EVENT_PROCESSING_LEASE_MS,
  releaseEvent,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, testDb } from "./helpers";

describe("イベントの重複の除去", () => {
  it("同じアカウントの同じ event_id は 1 回だけ受け付け、送り終えたら済んだ重複、送る途中なら処理中と答える", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const event = { accountId: alice.accountId, eventId: "e1" };

    expect(await beginEvent(db, event)).toEqual({ kind: "accepted" });
    expect(await beginEvent(db, event)).toEqual({ kind: "in_progress" });
    await completeEvent(db, event);
    expect(await beginEvent(db, event)).toEqual({ kind: "done" });
  });

  it("同時に 20 回届いても、受け付けるのは 1 回だけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        beginEvent(db, { accountId: alice.accountId, eventId: "e1" }),
      ),
    );

    expect(results.filter((result) => result.kind === "accepted")).toHaveLength(1);
  });

  it("event_id が同じでも、アカウントが違えば別のイベント", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);

    expect((await beginEvent(db, { accountId: alice.accountId, eventId: "e1" })).kind).toBe(
      "accepted",
    );
    expect((await beginEvent(db, { accountId: bob.accountId, eventId: "e1" })).kind).toBe(
      "accepted",
    );
  });

  it("送れなかったイベントは、記録を消すと、やり直しを受け付ける", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const event = { accountId: alice.accountId, eventId: "e1" };
    await beginEvent(db, event);

    expect(await releaseEvent(db, event)).toBe(true);

    expect((await beginEvent(db, event)).kind).toBe("accepted");
  });

  it("処理中のまま止まった記録は、期間を過ぎたやり直しで引き継ぐ。済んだ記録は引き継がない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const stuck = { accountId: alice.accountId, eventId: "stuck" };
    const finished = { accountId: alice.accountId, eventId: "finished" };
    const start = new Date("2026-11-04T00:00:00.000Z");
    await beginEvent(db, stuck, start);
    await beginEvent(db, finished, start);
    await completeEvent(db, finished, start);

    const withinLease = new Date(start.getTime() + EVENT_PROCESSING_LEASE_MS);
    const afterLease = new Date(start.getTime() + EVENT_PROCESSING_LEASE_MS + 1);
    expect((await beginEvent(db, stuck, withinLease)).kind).toBe("in_progress");
    expect((await beginEvent(db, stuck, afterLease)).kind).toBe("accepted");
    // 引き継いだら、また期間のあいだは処理中。
    expect((await beginEvent(db, stuck, afterLease)).kind).toBe("in_progress");
    expect((await beginEvent(db, finished, afterLease)).kind).toBe("done");
  });

  it("状態は processing と done だけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    await expect(
      env.DB.prepare(
        "INSERT INTO delivery_dedup (account_id, event_id, state) VALUES (?, 'e', 'other')",
      )
        .bind(alice.accountId)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("古い記録だけを消す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const old = { accountId: alice.accountId, eventId: "old" };
    const recent = { accountId: alice.accountId, eventId: "new" };
    await beginEvent(db, old, new Date("2026-10-01T00:00:00.000Z"));
    await completeEvent(db, old);
    await beginEvent(db, recent, new Date("2026-11-04T00:00:00.000Z"));
    await completeEvent(db, recent);

    expect(
      await deleteAcceptedEventsBefore(db, new Date("2026-11-01T00:00:00.000Z")),
    ).toBeGreaterThanOrEqual(1);

    expect((await beginEvent(db, old)).kind).toBe("accepted");
    expect((await beginEvent(db, recent)).kind).toBe("done");
  });
});
