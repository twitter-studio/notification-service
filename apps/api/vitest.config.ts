import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テストは Workers の実行環境 (workerd) で動かす。Node.js で動かすと、本番と違う API で通ってしまうため。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
