/** DB に置く時刻の形 (UTC の ISO 8601)。schema.ts の既定の値と同じ形にし、文字列のまま比べられるようにする。 */
export function toDbTime(date: Date): string {
  return date.toISOString();
}
