import {
  acceptEventOnce,
  deleteAcceptedEventsBefore,
  releaseEvent,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, testDb } from "./helpers";

describe("イベントの重複の除去", () => {
  it("同じアカウントの同じ event_id は、1 回だけ受け付ける", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    expect(await acceptEventOnce(db, { accountId: alice.accountId, eventId: "e1" })).toBe(true);
    expect(await acceptEventOnce(db, { accountId: alice.accountId, eventId: "e1" })).toBe(false);
  });

  it("同時に 20 回届いても、受け付けるのは 1 回だけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        acceptEventOnce(db, { accountId: alice.accountId, eventId: "e1" }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("event_id が同じでも、アカウントが違えば別のイベント", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);

    expect(await acceptEventOnce(db, { accountId: alice.accountId, eventId: "e1" })).toBe(true);
    expect(await acceptEventOnce(db, { accountId: bob.accountId, eventId: "e1" })).toBe(true);
  });

  it("送れなかったイベントは、記録を消すと、やり直しを受け付ける", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    await acceptEventOnce(db, { accountId: alice.accountId, eventId: "e1" });

    expect(await releaseEvent(db, { accountId: alice.accountId, eventId: "e1" })).toBe(true);

    expect(await acceptEventOnce(db, { accountId: alice.accountId, eventId: "e1" })).toBe(true);
  });

  it("古い記録だけを消す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    await acceptEventOnce(
      db,
      { accountId: alice.accountId, eventId: "old" },
      new Date("2026-10-01T00:00:00.000Z"),
    );
    await acceptEventOnce(
      db,
      { accountId: alice.accountId, eventId: "new" },
      new Date("2026-11-04T00:00:00.000Z"),
    );

    expect(
      await deleteAcceptedEventsBefore(db, new Date("2026-11-01T00:00:00.000Z")),
    ).toBeGreaterThanOrEqual(1);

    expect(await acceptEventOnce(db, { accountId: alice.accountId, eventId: "old" })).toBe(true);
    expect(await acceptEventOnce(db, { accountId: alice.accountId, eventId: "new" })).toBe(false);
  });
});
