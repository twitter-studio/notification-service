import { env } from "cloudflare:workers";
import { createAccountWithInstallation } from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { testDb } from "./helpers";

describe("アカウントとインストール", () => {
  it("アカウントは X の ID と関係のない UUID で、最初のインストールと一緒に作る", async () => {
    const db = testDb();

    const created = await createAccountWithInstallation(db, { publicKey: "key" });

    expect(created.accountId).toMatch(/^[0-9a-f-]{36}$/);
    const installation = await env.DB.prepare(
      "SELECT account_id, attestation_state FROM installations WHERE id = ?",
    )
      .bind(created.installationId)
      .first<{ account_id: string; attestation_state: string }>();
    expect(installation).toEqual({ account_id: created.accountId, attestation_state: "pending" });
  });

  it("作るたびに別のアカウントになる", async () => {
    const db = testDb();

    const first = await createAccountWithInstallation(db, { publicKey: "key" });
    const second = await createAccountWithInstallation(db, { publicKey: "key" });

    expect(second.accountId).not.toBe(first.accountId);
  });
});
