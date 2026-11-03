import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

export function createDb(d1: Parameters<typeof drizzle>[0]): Db {
  return drizzle(d1, { schema });
}
