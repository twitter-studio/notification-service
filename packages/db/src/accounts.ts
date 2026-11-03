import type { Db } from "./db";
import { installations, notificationAccounts } from "./schema";

export type CreatedAccount = { accountId: string; installationId: string };

/** 通知のアカウントと、その最初のインストールを作る。アカウントの ID は X の ID と関係のない UUID (ADR-0001)。 */
export async function createAccountWithInstallation(
  db: Db,
  input: { publicKey: string },
): Promise<CreatedAccount> {
  const accountId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  // 片方だけが残らないよう、1 つのバッチで作る (D1 のバッチは、まとめて成功するか、まとめて失敗する)。
  await db.batch([
    db.insert(notificationAccounts).values({ id: accountId }),
    db.insert(installations).values({ id: installationId, accountId, publicKey: input.publicKey }),
  ]);
  return { accountId, installationId };
}
