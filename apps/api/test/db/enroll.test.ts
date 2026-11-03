import { env } from "cloudflare:workers";
import {
  enrollInstallation,
  findActiveRelayCredential,
  isUniqueViolation,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { testDb, unique } from "./helpers";

describe("登録 (アカウント、インストール、中継の資格情報)", () => {
  it("アカウントは X の ID と関係のない UUID で、インストールと資格情報と一緒に作る", async () => {
    const db = testDb();
    const secretHash = unique("hash");

    const enrolled = await enrollInstallation(db, {
      publicKey: unique("key"),
      relaySecretHash: secretHash,
    });

    expect(enrolled.created).toBe(true);
    expect(enrolled.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect((await findActiveRelayCredential(db, secretHash))?.accountId).toBe(enrolled.accountId);
  });

  it("同じ公開鍵で呼び直すと、新しく作らず、前のアカウントとインストールを返す", async () => {
    const db = testDb();
    const publicKey = unique("key");
    const first = await enrollInstallation(db, { publicKey, relaySecretHash: unique("hash") });

    const retried = await enrollInstallation(db, { publicKey, relaySecretHash: unique("hash") });

    expect(retried).toEqual({
      accountId: first.accountId,
      installationId: first.installationId,
      created: false,
    });
  });

  it("途中で失敗したら、アカウントもインストールも残さない", async () => {
    const db = testDb();
    const takenHash = unique("hash");
    await enrollInstallation(db, { publicKey: unique("key"), relaySecretHash: takenHash });
    const publicKey = unique("key");

    await expect(enrollInstallation(db, { publicKey, relaySecretHash: takenHash })).rejects.toThrow(
      /UNIQUE/,
    );

    const installation = await env.DB.prepare(
      "SELECT count(*) AS count FROM installations WHERE public_key = ?",
    )
      .bind(publicKey)
      .first<{ count: number }>();
    expect(installation?.count).toBe(0);
  });

  it("1 つのアカウントに、有効なインストールは 1 つだけ", async () => {
    const enrolled = await enrollInstallation(testDb(), {
      publicKey: unique("key"),
      relaySecretHash: unique("hash"),
    });

    const second = env.DB.prepare(
      "INSERT INTO installations (id, account_id, public_key) VALUES (?, ?, ?)",
    ).bind(unique("installation"), enrolled.accountId, unique("key"));

    await expect(second.run()).rejects.toThrow(/UNIQUE/);
  });

  it("止めたアカウントの公開鍵で呼び直しても、そのアカウントは返さない", async () => {
    const db = testDb();
    const publicKey = unique("key");
    const first = await enrollInstallation(db, { publicKey, relaySecretHash: unique("hash") });
    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(first.accountId)
      .run();

    await expect(
      enrollInstallation(db, { publicKey, relaySecretHash: unique("hash") }),
    ).rejects.toSatisfy((error) => isUniqueViolation(error, "installations.public_key"));
  });
});
