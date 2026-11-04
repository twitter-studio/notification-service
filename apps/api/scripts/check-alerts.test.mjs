import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const healthy = {
  window_seconds: 300,
  http: { total: 0, unauthorized: 0, forbidden: 0, throttled: 0, failed: 0 },
  apns: { total: 0, auth_failed: 0, throttled: 0, failed: 0, exhausted: 0 },
  queue: { backlog: 0, backlog_bytes: 0, oldest_age_seconds: 0 },
};
for (const [name, input, expected] of [
  ["正常", JSON.stringify(healthy), 0],
  ["警報", JSON.stringify({ ...healthy, apns: { ...healthy.apns, exhausted: 1 } }), 2],
  ["欠けた集計", "{}", 1],
  ["壊れた入力", "canary-do-not-print", 1],
]) {
  test(`${name}を終了コードで区別し、入力を出力しない`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "notification-monitor-"));
    try {
      const path = join(directory, "aggregate.json");
      await writeFile(path, input, { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        [new URL("./check-alerts.mjs", import.meta.url).pathname, path],
        { encoding: "utf8" },
      );
      assert.equal(result.status, expected);
      assert.doesNotMatch(result.stdout + result.stderr, /canary-do-not-print|aggregate\.json/);
      assert.ok(JSON.parse(result.stdout || result.stderr).status);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
