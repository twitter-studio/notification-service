import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./db";
import { isUniqueViolation } from "./errors";
import { installations, notificationAccounts, relayCredentials } from "./schema";

export type Enrollment = {
  accountId: string;
  installationId: string;
  /** 新しく作ったときだけ。やり直しで既存のものを返したときは、資格情報を作り直すかを呼ぶ側が決める (AUTH-002)。 */
  relayCredentialId?: string;
  created: boolean;
};

/**
 * 通知のアカウント、最初のインストール、中継の資格情報を、1 つのバッチで作る (設計書 §3 の手順 3)。
 * アカウントの ID は X の ID と関係のない UUID (ADR-0001)。同じ公開鍵で呼び直したときは、新しく作らず、既存のものを返す。
 * 公開鍵を持っていることは、呼ぶ側 (AUTH-001) が署名で確かめてから呼ぶ。
 */
export async function enrollInstallation(
  db: Db,
  input: { publicKey: string; relaySecretHash: string },
  now = new Date(),
): Promise<Enrollment> {
  const accountId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const relayCredentialId = crypto.randomUUID();
  try {
    // D1 のバッチは、まとめて成功するか、まとめて取り消される。片方だけが残らない。
    await db.batch([
      db.insert(notificationAccounts).values({ id: accountId, createdAt: now }),
      db
        .insert(installations)
        .values({ id: installationId, accountId, publicKey: input.publicKey, createdAt: now }),
      db.insert(relayCredentials).values({
        id: relayCredentialId,
        accountId,
        secretHash: input.relaySecretHash,
        createdAt: now,
      }),
    ]);
    return { accountId, installationId, relayCredentialId, created: true };
  } catch (error) {
    if (!isUniqueViolation(error, "installations.public_key")) throw error;
    // 止めたアカウントや消したアカウントのものは返さない (呼ぶ側には、元のエラーのまま返す)。
    const existing = await db
      .select({ accountId: installations.accountId, installationId: installations.id })
      .from(installations)
      .innerJoin(notificationAccounts, eq(installations.accountId, notificationAccounts.id))
      .where(
        and(
          eq(installations.publicKey, input.publicKey),
          isNull(installations.revokedAt),
          eq(notificationAccounts.state, "active"),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (row === undefined) throw error;
    return { ...row, created: false };
  }
}
