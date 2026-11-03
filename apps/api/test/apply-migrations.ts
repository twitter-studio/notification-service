import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// 本番と同じ migration を、テストの D1 に当てる。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
