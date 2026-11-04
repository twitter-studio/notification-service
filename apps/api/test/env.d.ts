import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** テストだけで渡す migration (vitest.config.ts)。 */
      TEST_MIGRATIONS: D1Migration[];
      QA_MIGRATIONS: D1Migration[];
      QA_DB: D1Database;
      /** migration をデータの入った D1 に当てるテストだけで使う D1 (vitest.config.ts)。 */
      MIGRATION_DB: D1Database;
    }
  }
}
