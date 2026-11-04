import { and, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "./db";
import { isUniqueViolation } from "./errors";
import {
  installationAttestations,
  installations,
  notificationAccounts,
  relayCredentials,
  sessions,
  usedChallenges,
} from "./schema";
import type { BearerTokenHash } from "./types";

/**
 * 中継の資格情報の ID は、新しく作ったときだけ返す。やり直しで既存のものを返したときは、資格情報を作り直すかを
 * 呼ぶ側が決める (AUTH-002)。
 */
export type Enrollment =
  | { created: true; accountId: string; installationId: string; relayCredentialId: string }
  | { created: false; accountId: string; installationId: string };

/**
 * 通知のアカウント、最初のインストール、中継の資格情報を、1 つのバッチで作る (設計書 §3 の手順 3)。
 * アカウントの ID は X の ID と関係のない UUID (ADR-0001)。同じ公開鍵で呼び直したときは、新しく作らず、既存のものを返す。
 * 公開鍵を持っていることは、呼ぶ側 (AUTH-001) が署名で確かめてから呼ぶ。
 */
export type ConsumedChallenge = { nonce: string; expiresAt: Date };
export type NewAttestation = Omit<typeof installationAttestations.$inferInsert, "installationId">;
export type NewSession = { tokenHash: BearerTokenHash; expiresAt: Date };

export async function enrollInstallation(
  db: Db,
  input: {
    publicKey: string;
    attestation?: NewAttestation;
    relaySecretHash: BearerTokenHash;
    /** 署名に使ったチャレンジ。バッチの先頭で使ったものとして記録し、同じチャレンジの 2 回目は UNIQUE で失敗する。 */
    challenge: ConsumedChallenge;
    /** 一緒に作るセッション。 */
    session?: NewSession;
  },
  now = new Date(),
): Promise<Enrollment> {
  const accountId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const relayCredentialId = crypto.randomUUID();
  try {
    // D1 のバッチは、まとめて成功するか、まとめて取り消される。片方だけが残らない。
    const session =
      input.session === undefined
        ? []
        : [
            db.insert(sessions).values({
              id: crypto.randomUUID(),
              accountId,
              installationId,
              tokenHash: input.session.tokenHash,
              createdAt: now,
              expiresAt: input.session.expiresAt,
            }),
          ];
    // 使ったチャレンジの記録を先頭に置く。同じチャレンジの 2 回目は、何も作る前に UNIQUE で失敗する。
    const statements: BatchItem<"sqlite">[] = [
      db
        .insert(usedChallenges)
        .values({ nonce: input.challenge.nonce, expiresAt: input.challenge.expiresAt }),
      db.insert(notificationAccounts).values({ id: accountId, createdAt: now }),
      db.insert(installations).values({
        id: installationId,
        accountId,
        publicKey: input.publicKey,
        createdAt: now,
        lastUsedAt: now,
        attestationState: input.attestation === undefined ? "pending" : "verified",
      }),
      ...(input.attestation === undefined
        ? []
        : [db.insert(installationAttestations).values({ ...input.attestation, installationId })]),
      db.insert(relayCredentials).values({
        id: relayCredentialId,
        accountId,
        secretHash: input.relaySecretHash,
        createdAt: now,
      }),
      ...session,
    ];
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return { accountId, installationId, relayCredentialId, created: true as const };
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
    return { ...row, created: false as const };
  }
}
