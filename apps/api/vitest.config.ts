import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テストは Workers の実行環境 (workerd) で動かす。Node.js で動かすと、本番と違う API で通ってしまうため。
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/migrations", import.meta.url)),
  );
  const qaMigrations = await readD1Migrations(
    fileURLToPath(new URL("./qa/migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          outboundService: (request) => {
            if (
              request.url === `https://api.sandbox.push.apple.com/3/device/${"ab".repeat(32)}` &&
              request.method === "POST"
            )
              return new Response(null, { status: 200 });
            throw new Error("Unexpected outbound request in test");
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            QA_MIGRATIONS: qaMigrations,
            APNS_PROVIDER_KEYS: "",
            // テストだけの鍵 (本物の秘密ではない)。本物の鍵は Cloudflare の秘密に置く (ADR-0005)。
            DEVICE_TOKEN_KEYS: JSON.stringify({
              current: "test-1",
              keys: { "test-1": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" },
            }),
            DEVICE_TOKEN_FINGERPRINT_KEY: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=",
            CHALLENGE_SIGNING_KEY: "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8=",
            ENROLLMENT_INVITE_CODE: "test-invite-code-0123456789",
            DEVICE_TOKEN_KEY_CHECKS: JSON.stringify({
              fingerprint: "ded9776b92b0a8e2",
              keys: { "test-1": "8242446efc984a7c" },
            }),
          },
          // migration をデータの入った D1 に当てるテストのための、テストだけの D1。
          d1Databases: { MIGRATION_DB: "migration-test", QA_DB: "qa-lab-test" },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
