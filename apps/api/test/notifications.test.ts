import { env } from "cloudflare:workers";
import {
  beginEvent,
  createDb,
  listActiveDevices,
  registerDeviceToken,
  revokeRelayCredential,
} from "@notification-service/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import {
  eventKeyOf,
  NotificationRouteID,
  notificationPayload,
  type OutgoingNotification,
} from "../src/notifications/payload";
import type { PushOutcome, PushTarget } from "../src/notifications/push";
import { MAX_EVENT_AGE_MS, MAX_EVENTS_PER_DAY } from "../src/routes/notifications";
import { loadDeviceTokenKeys, sealDeviceToken } from "../src/security/device-token";
import { consumedChallenge, TOPIC, verifyDevice } from "./db/helpers";
import { type Enrolled, enrollNewDevice, expectProblem } from "./helpers/api";
import { jsonHeaders } from "./helpers/http";
import { expectLimitReached, outcomeOf } from "./helpers/rate-limit";

type Sent = { target: PushTarget; notification: OutgoingNotification; signal: AbortSignal };

async function keyOf(accountId: string, eventId: string): Promise<string> {
  return eventKeyOf(await loadDeviceTokenKeys(env), accountId, eventId);
}

/** 通知を、送らずに記録する app。`outcome` で、送り手の結果を決める。 */
function appWithPush(outcome: () => Promise<PushOutcome["kind"]> = async () => "sent") {
  const sent: Sent[] = [];
  const app = createApp({
    push: async (target, notification, { signal }) => {
      sent.push({ target, notification, signal });
      const kind = await outcome();
      return kind === "invalid_token" ? { kind, invalidatedBefore: Date.now() } : { kind };
    },
  });
  return { app, sent };
}

function newApnsToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** 登録して、トークンを持っていることを確かめた端末を持つアカウント。 */
async function accountWithDevice() {
  const { enrolled } = await enrollNewDevice();
  const apnsToken = newApnsToken();
  const sealed = await sealDeviceToken(await loadDeviceTokenKeys(env), apnsToken, {
    installationId: enrolled.installation_id,
    apnsEnvironment: "sandbox",
    topic: TOPIC,
  });
  const db = createDb(env.DB);
  const owner = { accountId: enrolled.account_id, installationId: enrolled.installation_id };
  const registered = await registerDeviceToken(db, {
    ...owner,
    apnsTokenCiphertext: sealed.ciphertext,
    tokenFingerprint: sealed.fingerprint,
    apnsEnvironment: "sandbox",
    topic: TOPIC,
    challenge: consumedChallenge(),
  });
  if (registered.kind !== "registered") throw new Error("device was not registered");
  expect(await verifyDevice(db, owner, registered.deviceId)).toBe(true);
  return { enrolled, apnsToken, deviceId: registered.deviceId };
}

function newEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: `event-${crypto.randomUUID()}`,
    type: "mention",
    post_id: "1234567890123456789",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

async function relay(app: ReturnType<typeof createApp>, secret: string | undefined, body: unknown) {
  const headers = jsonHeaders();
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  return app.request(
    "https://notification.test/v1/notifications",
    { method: "POST", headers, body: JSON.stringify(body) },
    env,
  );
}

describe("中継の受け付け", () => {
  it.each(["mention", "reply", "quote", "retweet", "like"])(
    "%s のプレビューを資格情報に紐づく端末だけに送る",
    async (type) => {
      const { app, sent } = appWithPush();
      const recipient = await accountWithDevice();
      await accountWithDevice();
      const preview = { author: "example", excerpt: "検証用のツイート" };
      const routeID = crypto.randomUUID();
      const event = newEvent({ type, preview, route_id: routeID });

      expect((await relay(app, recipient.enrolled.relay_secret, event)).status).toBe(202);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        target: { apnsToken: recipient.apnsToken },
        notification: {
          payload: {
            aps: { alert: { title: "@example", body: preview.excerpt }, "mutable-content": 1 },
            event_type: type,
            post_id: event.post_id,
            route_id: routeID,
            actor: { username: "example" },
          },
        },
      });
    },
  );

  it("公開アカウントの表示名とアイコンを、通知拡張の送った人として中継する", async () => {
    const { app, sent } = appWithPush();
    const recipient = await accountWithDevice();
    const image = "https://pbs.twimg.com/profile_images/1/example_normal.jpg";
    const routeID = crypto.randomUUID();
    const event = newEvent({
      type: "like",
      preview: {
        author: "example",
        excerpt: "検証用のツイート",
        author_name: "Example Name",
        author_image: image,
      },
      route_id: routeID,
    });
    const logs = ["log", "info", "warn", "error"].map((level) =>
      vi.spyOn(console, level as "log").mockImplementation(() => {}),
    );
    expect((await relay(app, recipient.enrolled.relay_secret, event)).status).toBe(202);
    expect(sent[0]?.notification.payload).toEqual({
      aps: {
        alert: { title: "@example", body: "検証用のツイート" },
        sound: "default",
        "mutable-content": 1,
      },
      event_type: "like",
      post_id: event.post_id,
      route_id: routeID,
      actor: { username: "example", name: "Example Name", image },
    });
    const logged = JSON.stringify(logs.map((spy) => spy.mock.calls));
    for (const value of ["Example Name", image, "検証用のツイート"])
      expect(logged).not.toContain(value);
  });

  it("いちばん大きいプレビューでも、APNs の 4KB に収まる", () => {
    const payload = notificationPayload({
      eventId: "large",
      type: "reply",
      postId: "1234567890123456789",
      routeId: NotificationRouteID.parse(crypto.randomUUID()),
      preview: {
        author: "a".repeat(15),
        excerpt: "界".repeat(280),
        author_name: "界".repeat(100),
        author_image: `https://pbs.twimg.com/profile_images/${"1".repeat(19)}/${"a".repeat(470)}`,
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(4096);
  });

  it("DM の暗号文だけを受け付けて、定型文付きの通知として中継する", async () => {
    const { app, sent } = appWithPush();
    const recipient = await accountWithDevice();
    await accountWithDevice();
    const routeID = crypto.randomUUID();
    const sealed = "A".repeat(3400);
    const event = newEvent({
      event_id: `x2_${"A".repeat(43)}`,
      type: "dm",
      post_id: undefined,
      route_id: routeID,
      dm_preview: sealed,
    });
    expect(
      (await relay(app, recipient.enrolled.relay_secret, { ...event, type: "follow" })).status,
    ).toBe(422);
    expect(
      (
        await relay(app, recipient.enrolled.relay_secret, {
          ...event,
          dm_preview: "A".repeat(3401),
        })
      ).status,
    ).toBe(422);
    expect((await relay(app, recipient.enrolled.relay_secret, event)).status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: { apnsToken: recipient.apnsToken },
      notification: {
        payload: {
          aps: {
            alert: { title: "Tweetbot", "loc-key": "You have a new direct message." },
            "mutable-content": 1,
          },
          event_type: "dm",
          route_id: routeID,
          dm_preview: { event_id: event.event_id, sealed },
        },
      },
    });
  });

  it.each([
    ["follow", { author: "example", excerpt: "preview" }],
    ["dm", { author: "example", excerpt: "preview" }],
    ["reply", { author: "other account", excerpt: "preview" }],
    ["mention", { author: "example", excerpt: "hello\u202eworld" }],
    ["reply", { author: "example", excerpt: "界".repeat(281) }],
    ["like", { author: "example", excerpt: "preview", author_name: "Exa\u202emple" }],
    ["like", { author: "example", excerpt: "preview", author_name: "N".repeat(101) }],
    ["like", { author: "example", excerpt: "preview", author_name: " padded" }],
    [
      "retweet",
      {
        author: "example",
        excerpt: "preview",
        author_image: "http://pbs.twimg.com/profile_images/1/a.jpg",
      },
    ],
    [
      "retweet",
      {
        author: "example",
        excerpt: "preview",
        author_image: "https://example.com/profile_images/1/a.jpg",
      },
    ],
    [
      "retweet",
      { author: "example", excerpt: "preview", author_image: "https://pbs.twimg.com/media/a.jpg" },
    ],
    [
      "retweet",
      {
        author: "example",
        excerpt: "preview",
        author_image: "https://pbs.twimg.com/profile_images/1/a.jpg?name=large",
      },
    ],
    ["mention", { author: "example", excerpt: "preview", author_id: "123" }],
    ["like", { author: "example", excerpt: "preview", author_name: "Exa\u2028mple" }],
    ["like", { author: "example", excerpt: "line\u2029break" }],
    [
      "retweet",
      {
        author: "example",
        excerpt: "preview",
        author_image: "https://pbs.twimg.com/profile_images/1/a.jpg?",
      },
    ],
    [
      "retweet",
      {
        author: "example",
        excerpt: "preview",
        author_image: "https://pbs.twimg.com/profile_images/1/a.jpg#",
      },
    ],
  ])("不正なプレビューを持つ %s は送らない", async (type, preview) => {
    const { app, sent } = appWithPush();
    const recipient = await accountWithDevice();
    expect(
      (
        await relay(
          app,
          recipient.enrolled.relay_secret,
          newEvent({
            type,
            preview,
            ...(type === "follow" || type === "dm"
              ? { post_id: undefined, route_id: crypto.randomUUID() }
              : {}),
          }),
        )
      ).status,
    ).toBe(422);
    expect(sent).toHaveLength(0);
  });
  it("中継の資格情報のアカウントの端末へ、中身を運ばない一般的な通知を送り、202 を返す", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const event = newEvent();

    const response = await relay(app, alice.enrolled.relay_secret, event);

    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ event_id: event.event_id, status: "accepted" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toMatchObject({
      deviceId: alice.deviceId,
      apnsToken: alice.apnsToken,
      apnsEnvironment: "sandbox",
      topic: TOPIC,
    });
    expect(sent[0]?.notification).toEqual({
      eventKey: await keyOf(alice.enrolled.account_id, event.event_id),
      payload: {
        aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
        event_type: "mention",
        post_id: "1234567890123456789",
      },
    });
  });

  it("DM はアカウント経路があるときに定型の通知を送り、本文とツイートIDを受け付けない", async () => {
    const { app, sent } = appWithPush();
    const recipient = await accountWithDevice();
    const secret = recipient.enrolled.relay_secret;
    const route_id = crypto.randomUUID();
    const { post_id, ...withoutPost } = newEvent({ type: "dm" });
    for (const invalid of [
      withoutPost,
      { ...withoutPost, route_id, post_id },
      { ...withoutPost, route_id, dm_excerpt: "private" },
    ])
      expect((await relay(app, secret, invalid)).status).toBe(422);
    expect((await relay(app, secret, { ...withoutPost, route_id })).status).toBe(202);
    expect(sent.map(({ notification }) => notification.payload)).toEqual([
      {
        aps: { alert: { "loc-key": "You have a new direct message." }, sound: "default" },
        event_type: "dm",
        route_id,
      },
    ]);
  });

  it("アプリ内の経路を通知へ渡すが、その識別子が指す別のアカウントの端末へは送らない", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const bob = await accountWithDevice();

    const routeId = bob.enrolled.account_id;
    const response = await relay(app, alice.enrolled.relay_secret, newEvent({ route_id: routeId }));

    expect(response.status).toBe(202);
    expect(sent[0]?.notification.payload.route_id).toBe(routeId);
    expect(sent.map((item) => item.target.deviceId)).toEqual([alice.deviceId]);
    expect(sent.map((item) => item.target.deviceId)).not.toContain(bob.deviceId);
  });

  it("同じ event_id は 1 回だけ送り、やり直しには duplicate を返す。アカウントが違えば別のイベント", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const bob = await accountWithDevice();
    const event = newEvent();

    await relay(app, alice.enrolled.relay_secret, event);
    const again = await relay(app, alice.enrolled.relay_secret, event);
    await relay(app, bob.enrolled.relay_secret, event);

    expect(await again.json()).toEqual({ event_id: event.event_id, status: "duplicate" });
    expect(sent.map((item) => item.target.deviceId)).toEqual([alice.deviceId, bob.deviceId]);
  });

  it("同じイベントを送っている途中のやり直しは、409 と Retry-After", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const event = newEvent();
    await beginEvent(createDb(env.DB), {
      accountId: alice.enrolled.account_id,
      eventKey: await keyOf(alice.enrolled.account_id, event.event_id),
    });

    const response = await relay(app, alice.enrolled.relay_secret, event);

    expect(response.headers.get("Retry-After")).toBe("30");
    await expectProblem(response, 409);
    expect(sent).toEqual([]);
  });

  it("送る途中で失敗したら 503 と Retry-After を返し、やり直しを受け付ける", async () => {
    const alice = await accountWithDevice();
    const event = newEvent();
    const failing = appWithPush(async () => {
      throw new Error("token=secret-value");
    });

    const failed = await relay(failing.app, alice.enrolled.relay_secret, event);

    expect(failed.headers.get("Retry-After")).toBe("60");
    const problem = await expectProblem(failed, 503);
    expect(JSON.stringify(problem)).not.toContain("secret-value");
    const working = appWithPush();
    const retried = await relay(working.app, alice.enrolled.relay_secret, event);
    expect(await retried.json()).toEqual({ event_id: event.event_id, status: "accepted" });
    expect(working.sent).toHaveLength(1);
  });

  it("APNs がトークンを無効と返したら、端末を止める", async () => {
    const { app } = appWithPush(async () => "invalid_token");
    const alice = await accountWithDevice();

    expect((await relay(app, alice.enrolled.relay_secret, newEvent())).status).toBe(202);

    expect(await listActiveDevices(createDb(env.DB), alice.enrolled.account_id)).toEqual([]);
  });

  it("確かめた端末がなければ、送らずに受け付ける。APNs へ送る仕組みがなくても受け付ける", async () => {
    const { app, sent } = appWithPush();
    const { enrolled } = await enrollNewDevice();
    const alice = await accountWithDevice();

    expect((await relay(app, enrolled.relay_secret, newEvent())).status).toBe(202);
    expect(sent).toEqual([]);
    expect((await relay(createApp(), alice.enrolled.relay_secret, newEvent())).status).toBe(202);
  });

  it("本文で、送り先、X の ID、トークン、文、URL を受けない。種類、ID、時刻の形も確かめる", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();

    for (const extra of [
      { account_id: crypto.randomUUID() },
      { route_id: "12345" },
      { x_user_id: "12345" },
      { apns_token: newApnsToken() },
      { title: "Hello" },
      { body: "Hello" },
      { url: "https://example.com" },
      { type: "dm" },
      { post_id: "abc" },
      { post_id: "0123" },
      { post_id: "12345678901234567890" },
      { post_id: undefined },
      { type: "follow" },
      { event_id: "has space" },
      { event_id: "" },
      { occurred_at: "2026-11-04T09:00:00+09:00" },
      { occurred_at: "yesterday" },
    ]) {
      await expectProblem(await relay(app, alice.enrolled.relay_secret, newEvent(extra)), 422);
    }
    expect(sent).toEqual([]);
  });

  it("古すぎるイベント (受け付けの記録が消えた後のやり直し) と、先の時刻のイベントは 422", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const now = Date.now();

    for (const occurredAt of [now - MAX_EVENT_AGE_MS - 60_000, now + 10 * 60 * 1000]) {
      const problem = await expectProblem(
        await relay(
          app,
          alice.enrolled.relay_secret,
          newEvent({ occurred_at: new Date(occurredAt).toISOString() }),
        ),
        422,
      );
      expect(problem.detail).toBe("The event time is out of range.");
    }
    expect(
      (
        await relay(
          app,
          alice.enrolled.relay_secret,
          newEvent({ occurred_at: new Date(now - MAX_EVENT_AGE_MS + 60_000).toISOString() }),
        )
      ).status,
    ).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it("中継の資格情報がない、セッションのトークン、取り消した資格情報は 401 で、秘密を返さない", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const revoked: Enrolled = (await enrollNewDevice()).enrolled;
    await revokeRelayCredential(createDb(env.DB), {
      accountId: revoked.account_id,
      credentialId: revoked.relay_credential_id ?? "",
    });

    for (const secret of [undefined, alice.enrolled.session.token, revoked.relay_secret]) {
      const response = await relay(app, secret, newEvent());
      const text = await response.clone().text();
      await expectProblem(response, 401);
      if (secret !== undefined) expect(text).not.toContain(secret);
    }
    expect(sent).toEqual([]);
  });

  it("アカウントごとに数え、多すぎると 429", async () => {
    const { app } = appWithPush();
    const alice = await accountWithDevice();

    await expectLimitReached(30, async () =>
      outcomeOf((await relay(app, alice.enrolled.relay_secret, newEvent())).status, 202),
    );
  });

  it("形の違う本文も、アカウントごとの回数に数える", async () => {
    const { app } = appWithPush();
    const alice = await accountWithDevice();

    await expectLimitReached(30, async () =>
      outcomeOf(
        (await relay(app, alice.enrolled.relay_secret, newEvent({ type: "unknown" }))).status,
        422,
      ),
    );
  });

  it("follow は post_id なしで受け、通知にも post_id を入れない", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();

    const response = await relay(
      app,
      alice.enrolled.relay_secret,
      newEvent({ type: "follow", post_id: undefined }),
    );

    expect(response.status).toBe(202);
    expect(sent[0]?.notification.payload).toEqual({
      aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
      event_type: "follow",
    });
  });

  it("処理中のまま 2 分を過ぎた記録は、やり直しで引き継いで送る", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const event = newEvent();
    await beginEvent(
      createDb(env.DB),
      {
        accountId: alice.enrolled.account_id,
        eventKey: await keyOf(alice.enrolled.account_id, event.event_id),
      },
      new Date(Date.now() - 3 * 60 * 1000),
    );

    const response = await relay(app, alice.enrolled.relay_secret, event);

    expect(await response.json()).toEqual({ event_id: event.event_id, status: "accepted" });
    expect(sent).toHaveLength(1);
  });

  it("端末に送れなかった (やり直し、失敗、読めない暗号文) ときも 202 で、error のログに数を出し、秘密を出さない", async () => {
    for (const outcome of ["retry_later", "failed"] as const) {
      const { app } = appWithPush(async () => outcome);
      const alice = await accountWithDevice();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      expect((await relay(app, alice.enrolled.relay_secret, newEvent())).status).toBe(202);

      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain(`\\"${outcome}\\":1`);
      expect(logged).not.toContain(alice.apnsToken);
      expect(logged).not.toContain(alice.enrolled.relay_secret ?? "");
      errors.mockRestore();
    }

    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    await env.DB.prepare(
      "UPDATE devices SET apns_token_ciphertext = 'v1.test-1.AAAA.AAAA' WHERE id = ?",
    )
      .bind(alice.deviceId)
      .run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await relay(app, alice.enrolled.relay_secret, newEvent())).status).toBe(202);
    expect(JSON.stringify(errors.mock.calls)).toContain('\\"unreadable\\":1');
    expect(sent).toEqual([]);
    errors.mockRestore();
  });

  it("受け付けの記録を書けないときは 503、送った後に済みにできないときは 202", async () => {
    const alice = await accountWithDevice();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, sent } = appWithPush();
    const send = (db: D1Database) =>
      app.request(
        "https://notification.test/v1/notifications",
        {
          method: "POST",
          headers: relayHeaders(alice.enrolled.relay_secret),
          body: JSON.stringify(newEvent()),
        },
        { ...env, DB: db },
      );

    const beginFails = await send(failingD1(env.DB, /INSERT INTO delivery_dedup/i));
    expect(beginFails.headers.get("Retry-After")).toBe("60");
    await expectProblem(beginFails, 503);
    expect(sent).toEqual([]);

    const completeFails = await send(failingD1(env.DB, /update "delivery_dedup"/i));
    expect(completeFails.status).toBe(202);
    expect(sent).toHaveLength(1);
    quiet.mockRestore();
  });

  it("1 日に受け付けられる数を超えると 429 で、送らない。済んだ重複と処理中のやり直しの答えは変えない", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const done = newEvent();
    await relay(app, alice.enrolled.relay_secret, done);
    const processing = newEvent();
    await beginEvent(createDb(env.DB), {
      accountId: alice.enrolled.account_id,
      eventKey: await keyOf(alice.enrolled.account_id, processing.event_id),
    });
    await env.DB.prepare("UPDATE relay_usage SET count = ? WHERE account_id = ?")
      .bind(MAX_EVENTS_PER_DAY, alice.enrolled.account_id)
      .run();

    const response = await relay(app, alice.enrolled.relay_secret, newEvent());

    // 次の UTC の 0 時まで待ってもらう。
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    await expectProblem(response, 429);
    expect(sent).toHaveLength(1);
    expect(await (await relay(app, alice.enrolled.relay_secret, done)).json()).toEqual({
      event_id: done.event_id,
      status: "duplicate",
    });
    await expectProblem(await relay(app, alice.enrolled.relay_secret, processing), 409);

    // 止まった処理中の記録は、最初に受け付けたときに数えているので、上限の後でも引き継いで送る。
    const stale = newEvent();
    await beginEvent(
      createDb(env.DB),
      {
        accountId: alice.enrolled.account_id,
        eventKey: await keyOf(alice.enrolled.account_id, stale.event_id),
      },
      new Date(Date.now() - 3 * 60 * 1000),
    );
    expect(await (await relay(app, alice.enrolled.relay_secret, stale)).json()).toEqual({
      event_id: stale.event_id,
      status: "accepted",
    });
    expect(sent).toHaveLength(2);
  });

  it("送り先の端末がなければ、受け付けの記録も 1 日の数も書かない", async () => {
    const { app } = appWithPush();
    const { enrolled } = await enrollNewDevice();

    expect((await relay(app, enrolled.relay_secret, newEvent())).status).toBe(202);

    for (const table of ["delivery_dedup", "relay_usage"]) {
      const row = await env.DB.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE account_id = ?`,
      )
        .bind(enrolled.account_id)
        .first<{ count: number }>();
      expect(row?.count, table).toBe(0);
    }
  });

  it("送り手に、送る時間の上限の signal を渡す。上限を過ぎたら送らず、error のログに出す", async () => {
    const first = appWithPush();
    const alice = await accountWithDevice();
    await relay(first.app, alice.enrolled.relay_secret, newEvent());
    expect(first.sent[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(first.sent[0]?.signal.aborted).toBe(false);

    const sent: unknown[] = [];
    const expired = createApp({
      push: async (target) => {
        sent.push(target);
        return { kind: "sent" };
      },
      relaySendBudgetMs: 0,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await relay(expired, alice.enrolled.relay_secret, newEvent())).status).toBe(202);
    expect(sent).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).toContain('\\"skipped\\":1');
    errors.mockRestore();
  });

  it("送っている間に、ほかの要求に引き継がれたら、済みにせず、ログに出す", async () => {
    const alice = await accountWithDevice();
    const event = newEvent();
    const eventKey = await keyOf(alice.enrolled.account_id, event.event_id);
    const { app } = appWithPush(async () => {
      // 送っている間にリースが切れ、ほかの要求が引き継いだ。
      await env.DB.prepare(
        "UPDATE delivery_dedup SET lease_id = 'other' WHERE account_id = ? AND event_key = ?",
      )
        .bind(alice.enrolled.account_id, eventKey)
        .run();
      return "sent";
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await relay(app, alice.enrolled.relay_secret, event)).status).toBe(202);

    expect(JSON.stringify(errors.mock.calls)).toContain("relay_lease_lost");
    const row = await env.DB.prepare(
      "SELECT state FROM delivery_dedup WHERE account_id = ? AND event_key = ?",
    )
      .bind(alice.enrolled.account_id, eventKey)
      .first<{ state: string }>();
    expect(row?.state).toBe("processing");
    errors.mockRestore();
  });

  it("受け付けの記録には、event_id の生の値を置かない", async () => {
    const { app } = appWithPush();
    const alice = await accountWithDevice();
    const event = newEvent({ event_id: "mention:1234567890123456789" });

    await relay(app, alice.enrolled.relay_secret, event);

    const rows = await env.DB.prepare("SELECT event_key FROM delivery_dedup WHERE account_id = ?")
      .bind(alice.enrolled.account_id)
      .all<{ event_key: string }>();
    expect(rows.results.map((row) => row.event_key)).toEqual([
      await keyOf(alice.enrolled.account_id, event.event_id),
    ]);
    expect(JSON.stringify(rows.results)).not.toContain("1234567890123456789");
  });
});

function relayHeaders(secret: string | undefined): Record<string, string> {
  const headers = jsonHeaders();
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/** SQL が `pattern` に合う文だけを失敗させる D1 (それ以外は、そのまま渡す)。 */
function failingD1(db: D1Database, pattern: RegExp): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (!pattern.test(sql)) return target.prepare(sql);
          const failing: unknown = new Proxy(
            {},
            {
              get: (_, name) =>
                name === "bind"
                  ? () => failing
                  : async () => {
                      throw new Error("D1_ERROR: injected failure");
                    },
            },
          );
          return failing;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
