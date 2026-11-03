import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDb(d1: Parameters<typeof drizzle>[0]) {
  return drizzle(d1, { schema });
}

/** Drizzle の D1 のクライアント。`$client` で D1 そのもの (生の SQL のバッチ) も使う。 */
export type Db = ReturnType<typeof createDb>;
