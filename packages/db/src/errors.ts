/** D1 の一意の制約の違反か。どの制約かは、SQLite が出す列の並び (`devices.token_fingerprint, …`) で見分ける。 */
export function isUniqueViolation(error: unknown, columns: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message.includes(`UNIQUE constraint failed: ${columns}`)) return true;
    current = current.cause;
  }
  return false;
}
