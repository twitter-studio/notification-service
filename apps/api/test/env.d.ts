import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** テストだけで渡す migration (vitest.config.ts)。 */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
