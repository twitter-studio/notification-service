import { env } from "cloudflare:workers";
import {
  createDb,
  deleteAccountFromInstallation,
  findActiveInstallation,
  revokeInstallation,
} from "@notification-service/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { DeviceVerificationPush } from "../src/devices/verification";
import type { PushGateway } from "../src/notifications/push";
import { deleteAccountMessage, deviceMessage } from "../src/security/installation-key";
import { consumedChallenge } from "./db/helpers";
import { call, enrollNewDevice, issueTestChallenge } from "./helpers/api";
import { jsonHeaders } from "./helpers/http";
import { expectLimitReached, outcomeOf } from "./helpers/rate-limit";

type Owner = Awaited<ReturnType<typeof enrollNewDevice>>;
function setup() {
  const codes: DeviceVerificationPush[] = [];
  const push = vi.fn<PushGateway>(async () => ({ kind: "sent" }));
  const app = createApp({
    push,
    sendDeviceVerification: async (value) => {
      codes.push(value);
      return true;
    },
  });
  const request = (owner: Owner, method: string, path: string, body?: unknown) =>
    app.request(
      `https://notification.test${path}`,
      {
        method,
        headers: { ...jsonHeaders(), Authorization: `Bearer ${owner.enrolled.session.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  return { push, codes, request };
}
async function register(context: ReturnType<typeof setup>, owner: Owner, verified = true) {
  const challenge = await issueTestChallenge("device");
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const body = {
    apnsToken: token,
    apnsEnvironment: "sandbox",
    topic: "com.twitter-studio.Tweetbot",
  };
  const result = await context.request(
    owner,
    "PUT",
    `/v1/devices/${owner.enrolled.installation_id}`,
    {
      apns_token: token,
      apns_environment: body.apnsEnvironment,
      topic: body.topic,
      challenge,
      signature: await owner.device.sign(
        deviceMessage(challenge, owner.enrolled.installation_id, body),
      ),
    },
  );
  expect(result.status).toBe(200);
  if (verified) {
    const code = context.codes.at(-1)?.code;
    expect(
      (
        await context.request(
          owner,
          "POST",
          `/v1/devices/${owner.enrolled.installation_id}/verification`,
          { code },
        )
      ).status,
    ).toBe(200);
  }
  return token;
}
async function deletion(
  owner: Owner,
  purpose: "delete_account" | "relay_credential" = "delete_account",
) {
  const challenge = await issueTestChallenge(purpose);
  return {
    challenge,
    signature: await owner.device.sign(
      deleteAccountMessage(challenge, owner.enrolled.installation_id),
    ),
  };
}

describe("アプリの通知設定", () => {
  it("どの入口もアカウントのセッションを求める", async () => {
    for (const [method, path] of [
      ["GET", "/v1/settings"],
      ["DELETE", "/v1/account"],
      ["POST", "/v1/notifications/test"],
    ])
      expect(
        (await call(method ?? "GET", path ?? "/", method === "GET" ? {} : { body: {} })).status,
      ).toBe(401);
  });
  it("自分の端末と資格情報の公開情報だけを返す", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    const other = await enrollNewDevice();
    const token = await register(ctx, owner);
    const response = await ctx.request(owner, "GET", "/v1/settings");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const value = await response.json<Record<string, unknown>>();
    expect(value).toEqual({
      device: { device_id: expect.any(String), state: "active", verified: true },
      relay_credential: { id: owner.enrolled.relay_credential_id, expires_at: null },
    });
    const text = JSON.stringify(value);
    for (const secret of [
      token,
      owner.enrolled.session.token,
      owner.enrolled.relay_secret,
      other.enrolled.account_id,
    ])
      if (secret) expect(text).not.toContain(secret);
    expect(Object.keys(value)).toEqual(["device", "relay_credential"]);
    expect((await ctx.request(other, "GET", "/v1/settings")).status).toBe(200);
  });
  it("端末がない・未確認・停止・無効のときテスト通知を送らない", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    expect((await ctx.request(owner, "POST", "/v1/notifications/test")).status).toBe(409);
    await register(ctx, owner, false);
    expect((await ctx.request(owner, "POST", "/v1/notifications/test")).status).toBe(409);
    const code = ctx.codes.at(-1)?.code;
    expect(
      (
        await ctx.request(
          owner,
          "POST",
          `/v1/devices/${owner.enrolled.installation_id}/verification`,
          { code },
        )
      ).status,
    ).toBe(200);
    expect(
      (await ctx.request(owner, "DELETE", `/v1/devices/${owner.enrolled.installation_id}`)).status,
    ).toBe(204);
    expect((await ctx.request(owner, "POST", "/v1/notifications/test")).status).toBe(409);
    await env.DB.prepare("UPDATE devices SET state = 'invalidated' WHERE installation_id = ?")
      .bind(owner.enrolled.installation_id)
      .run();
    expect((await ctx.request(owner, "POST", "/v1/notifications/test")).status).toBe(409);
    expect(ctx.push).not.toHaveBeenCalled();
  });
  it("資格情報を取り消しても自分の確認済み端末に固定の通知だけを送り、回数を制限する", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    await register(ctx, owner);
    expect(
      (
        await ctx.request(
          owner,
          "DELETE",
          `/v1/relay-credentials/${owner.enrolled.relay_credential_id}`,
        )
      ).status,
    ).toBe(204);
    await expectLimitReached(5, async () => {
      const result = await ctx.request(owner, "POST", "/v1/notifications/test");
      if (result.status === 200) expect(await result.json()).toEqual({ status: "sent" });
      return outcomeOf(result.status, 200);
    });
    for (const [target, notification] of ctx.push.mock.calls) {
      expect(target.accountId).toBe(owner.enrolled.account_id);
      expect(target.authority).toEqual({
        kind: "installation",
        installationId: owner.enrolled.installation_id,
      });
      expect(notification.payload).toEqual({
        aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
        event_type: "test",
      });
    }
  });
  it("テスト通知も中継と同じ日次枠を使う", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    await register(ctx, owner);
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    await env.DB.prepare(
      "INSERT INTO relay_usage (account_id, window_start, count) VALUES (?, ?, 1000)",
    )
      .bind(owner.enrolled.account_id, day.getTime())
      .run();
    const result = await ctx.request(owner, "POST", "/v1/notifications/test");
    expect(result.status).toBe(429);
    expect(Number(result.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(ctx.push).not.toHaveBeenCalled();
  });
  it("送れないとき503を返し、無効トークンの応答は端末の状態に反映する", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    await register(ctx, owner);
    ctx.push.mockRejectedValueOnce(new Error("private-url-and-token"));
    const failed = await ctx.request(owner, "POST", "/v1/notifications/test");
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Retry-After")).toBe("60");
    expect(await failed.text()).not.toContain("private-url-and-token");
    ctx.push.mockResolvedValueOnce({ kind: "not_configured" });
    expect((await ctx.request(owner, "POST", "/v1/notifications/test")).status).toBe(503);
    ctx.push.mockResolvedValueOnce({ kind: "invalid_token", invalidatedBefore: Date.now() });
    expect((await ctx.request(owner, "POST", "/v1/notifications/test")).status).toBe(503);
    const settings = await (await ctx.request(owner, "GET", "/v1/settings")).json<{
      device: { state: string };
    }>();
    expect(settings.device.state).toBe("invalidated");
  });
  it("削除には専用の新しい署名を求め、他の端末の署名や別用途を拒む", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    const other = await enrollNewDevice();
    const proof = await deletion(owner);
    expect((await ctx.request(other, "DELETE", "/v1/account", proof)).status).toBe(401);
    expect(
      (await ctx.request(owner, "DELETE", "/v1/account", await deletion(owner, "relay_credential")))
        .status,
    ).toBe(401);
    expect((await ctx.request(owner, "GET", "/v1/settings")).status).toBe(200);
  });
  it("削除で自分の秘密を消し、セッション・中継資格情報・再登録を無効にし、他のアカウントは維持する", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    const other = await enrollNewDevice();
    await register(ctx, owner);
    expect((await ctx.request(owner, "DELETE", "/v1/account", await deletion(owner))).status).toBe(
      204,
    );
    expect((await ctx.request(owner, "GET", "/v1/settings")).status).toBe(401);
    expect(
      (
        await call("POST", "/v1/notifications", {
          token: owner.enrolled.relay_secret ?? "missing-secret",
          body: {},
        })
      ).status,
    ).toBe(401);
    expect((await ctx.request(other, "GET", "/v1/settings")).status).toBe(200);
    expect(
      await findActiveInstallation(createDb(env.DB), owner.enrolled.installation_id),
    ).toBeUndefined();
    for (const table of [
      "installations",
      "sessions",
      "relay_credentials",
      "delivery_dedup",
      "relay_usage",
    ])
      expect(
        (
          await env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_id = ?`)
            .bind(owner.enrolled.account_id)
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
  });
  it("削除バッチは取り消し済み・別アカウントのインストールでアカウントを消さず、チャレンジを使い回さない", async () => {
    const ctx = setup();
    const owner = await enrollNewDevice();
    const other = await enrollNewDevice();
    const db = createDb(env.DB);
    const challenge = consumedChallenge();
    expect(
      await deleteAccountFromInstallation(db, {
        accountId: owner.enrolled.account_id,
        installationId: other.enrolled.installation_id,
        challenge,
      }),
    ).toBe(false);
    await expect(
      deleteAccountFromInstallation(db, {
        accountId: owner.enrolled.account_id,
        installationId: owner.enrolled.installation_id,
        challenge,
      }),
    ).rejects.toThrow();
    await revokeInstallation(db, {
      accountId: owner.enrolled.account_id,
      installationId: owner.enrolled.installation_id,
    });
    expect(
      await deleteAccountFromInstallation(db, {
        accountId: owner.enrolled.account_id,
        installationId: owner.enrolled.installation_id,
        challenge: consumedChallenge(),
      }),
    ).toBe(false);
    const row = await env.DB.prepare("SELECT state FROM notification_accounts WHERE id = ?")
      .bind(owner.enrolled.account_id)
      .first<{ state: string }>();
    expect(row?.state).toBe("active");
    expect((await ctx.request(other, "GET", "/v1/settings")).status).toBe(200);
  });
});
