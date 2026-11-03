/**
 * D1 の一意の制約の違反か。どの制約かは、SQLite が出す列の並び (`devices.token_fingerprint, …`) で見分ける。
 * いちばん内側のエラー (D1 のエラー) の先頭だけを見る。Drizzle が包んだエラーの文にはクエリのパラメータが入るので、
 * 文の途中まで探すと、パラメータの値で誤って判定してしまうため。
 */
export function isUniqueViolation(error: unknown, columns: string): boolean {
  let innermost: unknown = error;
  while (innermost instanceof Error && innermost.cause instanceof Error)
    innermost = innermost.cause;
  if (!(innermost instanceof Error)) return false;
  const message = innermost.message.replace(/^D1_ERROR: /, "");
  const prefix = `UNIQUE constraint failed: ${columns}`;
  return message === prefix || message.startsWith(`${prefix}:`);
}
