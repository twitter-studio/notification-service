import { env } from "cloudflare:workers";
import {
  beginEvent,
  completeEvent,
  consumeDailyRelayQuota,
  createDb,
  deleteAcceptedEventsBefore,
  EVENT_PROCESSING_LEASE_MS,
  type EventStart,
  findEventState,
  releaseEvent,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, testDb } from "./helpers";

/** 受け付けたときのリースの ID。受け付けなかったらテストを失敗にする。 */
function leaseOf(start: EventStart): string {
  if (start.kind !== "accepted") throw new Error(`expected accepted, got ${start.kind}`);
  return start.leaseId;
}

describe("イベントの重複の除去", () => {
  it("同じアカウントの同じイベントは 1 回だけ受け付け、送り終えたら済んだ重複、送る途中なら処理中と答える", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const event = { accountId: alice.accountId, eventKey: "e1" };

    const leaseId = leaseOf(await beginEvent(db, event));
    expect(await beginEvent(db, event)).toEqual({ kind: "in_progress" });
    expect(await completeEvent(db, { ...event, leaseId })).toBe(true);
    expect(await beginEvent(db, event)).toEqual({ kind: "done" });
  });

  it("同時に 20 回届いても、受け付けるのは 1 回だけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        beginEvent(db, { accountId: alice.accountId, eventKey: "e1" }),
      ),
    );

    expect(results.filter((result) => result.kind === "accepted")).toHaveLength(1);
  });

  it("イベントが同じでも、アカウントが違えば別のイベント", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);

    expect((await beginEvent(db, { accountId: alice.accountId, eventKey: "e1" })).kind).toBe(
      "accepted",
    );
    expect((await beginEvent(db, { accountId: bob.accountId, eventKey: "e1" })).kind).toBe(
      "accepted",
    );
  });

  it("送れなかったイベントは、記録を消すと、やり直しを受け付ける", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const event = { accountId: alice.accountId, eventKey: "e1" };
    const leaseId = leaseOf(await beginEvent(db, event));

    expect(await releaseEvent(db, { ...event, leaseId })).toBe(true);

    expect((await beginEvent(db, event)).kind).toBe("accepted");
  });

  it("処理中のまま止まった記録は、期間を過ぎたやり直しで引き継ぐ。済んだ記録は引き継がない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const stuck = { accountId: alice.accountId, eventKey: "stuck" };
    const finished = { accountId: alice.accountId, eventKey: "finished" };
    const start = new Date("2026-11-04T00:00:00.000Z");
    await beginEvent(db, stuck, start);
    const finishedLease = leaseOf(await beginEvent(db, finished, start));
    await completeEvent(db, { ...finished, leaseId: finishedLease }, start);

    const withinLease = new Date(start.getTime() + EVENT_PROCESSING_LEASE_MS);
    const afterLease = new Date(start.getTime() + EVENT_PROCESSING_LEASE_MS + 1);
    expect((await beginEvent(db, stuck, withinLease)).kind).toBe("in_progress");
    expect((await beginEvent(db, stuck, afterLease)).kind).toBe("accepted");
    // 引き継いだら、また期間のあいだは処理中。
    expect((await beginEvent(db, stuck, afterLease)).kind).toBe("in_progress");
    expect((await beginEvent(db, finished, afterLease)).kind).toBe("done");
  });

  it("引き継がれた後の前の要求は、記録を消すことも、済みにすることもできない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const event = { accountId: alice.accountId, eventKey: "taken-over" };
    const start = new Date("2026-11-04T00:00:00.000Z");
    const first = leaseOf(await beginEvent(db, event, start));
    const second = leaseOf(
      await beginEvent(db, event, new Date(start.getTime() + EVENT_PROCESSING_LEASE_MS + 1)),
    );

    expect(await releaseEvent(db, { ...event, leaseId: first })).toBe(false);
    expect(await completeEvent(db, { ...event, leaseId: first })).toBe(false);
    expect((await beginEvent(db, event, start)).kind).toBe("in_progress");

    // 引き継いだ要求が済みにしたら、前の要求は消せない (消すと、もう 1 回送ってしまう)。
    expect(await completeEvent(db, { ...event, leaseId: second })).toBe(true);
    expect(await releaseEvent(db, { ...event, leaseId: second })).toBe(false);
    expect((await beginEvent(db, event)).kind).toBe("done");
  });

  it("状態は processing と done だけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    await expect(
      env.DB.prepare(
        "INSERT INTO delivery_dedup (account_id, event_key, state) VALUES (?, 'e', 'other')",
      )
        .bind(alice.accountId)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("記録の状態は、ない・止まった処理中なら open、済みなら done、処理中なら in_progress", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const event = { accountId: alice.accountId, eventKey: "state" };
    const start = new Date("2026-11-04T00:00:00.000Z");

    expect(await findEventState(db, event, start)).toBe("open");
    const leaseId = leaseOf(await beginEvent(db, event, start));
    expect(await findEventState(db, event, start)).toBe("in_progress");
    expect(
      await findEventState(db, event, new Date(start.getTime() + EVENT_PROCESSING_LEASE_MS + 1)),
    ).toBe("open");
    await completeEvent(db, { ...event, leaseId }, start);
    expect(await findEventState(db, event, start)).toBe("done");
  });

  it("1 日の数は、上限まで数え、1 日を過ぎたら数え直す。アカウントごとに分ける", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const start = new Date("2026-11-04T00:00:00.000Z");
    const consume = (accountId: string, at: Date) =>
      consumeDailyRelayQuota(db, { accountId, limit: 3 }, at);

    const results = [];
    for (let index = 0; index < 4; index++) {
      results.push(await consume(alice.accountId, new Date(start.getTime() + index)));
    }
    expect(results).toEqual([true, true, true, false]);
    expect(await consume(bob.accountId, start)).toBe(true);
    expect(await consume(alice.accountId, new Date(start.getTime() + 24 * 60 * 60 * 1000))).toBe(
      true,
    );
  });

  it("同時に数えても、上限を越えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumeDailyRelayQuota(db, { accountId: alice.accountId, limit: 3 }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("掃除は、古い行を受け付けた順に探し、ほかのアカウントの新しい行を読み直さない", async () => {
    const before = new Date("2026-11-01T00:00:00.000Z");
    const [first, second] = [await newAccount(testDb()), await newAccount(testDb())].sort((a, b) =>
      a.accountId.localeCompare(b.accountId),
    );
    // 索引の順 (アカウントの順) では先に来るアカウントに新しい行を、後のアカウントに古い行を、古い行から先に置く。
    const insert = (accountId: string, prefix: string, at: number, count: number) =>
      env.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?4)
        INSERT INTO delivery_dedup (account_id, event_key, accepted_at, state, updated_at)
        SELECT ?1, ?2 || i, ?3, 'done', ?3 FROM n`)
        .bind(accountId, prefix, at, count)
        .run();
    await insert(second?.accountId ?? "", "old-", before.getTime() - 1, 300);
    await insert(first?.accountId ?? "", "new-", before.getTime() + 1, 2000);
    let rowsRead = 0;
    const counting = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  const result = await bound.run();
                  rowsRead += result.meta.rows_read;
                  return result;
                },
              };
            },
          };
        };
      },
    }) as D1Database;

    expect(await deleteAcceptedEventsBefore(createDb(counting), before, 100)).toBe(100);

    // 古い行 100 件を探すのに、新しい 2,000 行は読まない。
    expect(rowsRead).toBeLessThan(500);
  });

  it("古い記録だけを消す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const old = { accountId: alice.accountId, eventKey: "old" };
    const recent = { accountId: alice.accountId, eventKey: "new" };
    const oldLease = leaseOf(await beginEvent(db, old, new Date("2026-10-01T00:00:00.000Z")));
    await completeEvent(db, { ...old, leaseId: oldLease });
    const recentLease = leaseOf(await beginEvent(db, recent, new Date("2026-11-04T00:00:00.000Z")));
    await completeEvent(db, { ...recent, leaseId: recentLease });

    expect(
      await deleteAcceptedEventsBefore(db, new Date("2026-11-01T00:00:00.000Z")),
    ).toBeGreaterThanOrEqual(1);

    expect((await beginEvent(db, old)).kind).toBe("accepted");
    expect((await beginEvent(db, recent)).kind).toBe("done");
  });
});
