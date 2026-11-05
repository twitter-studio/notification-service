import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readRelayToken, runRelayLoad } from "./relay-load.mjs";

const token = `tsr_${"a".repeat(43)}`;

function fixture(overrides = new Map()) {
  const records = [];
  const calls = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let waits = 0;
  const options = {
    token,
    record: async (value) => records.push(value),
    wait: async () => {
      waits++;
    },
    send: async (url, init) => {
      concurrent++;
      maxConcurrent = Math.max(concurrent, maxConcurrent);
      const sequence = calls.length + 1;
      const body = JSON.parse(init.body);
      calls.push({ url, body, init });
      assert.ok(
        records.some(
          (r) => r.stage === "reserved" && sequence >= r.first && sequence < r.first + r.count,
        ),
      );
      await new Promise(setImmediate);
      concurrent--;
      const override = overrides.get(sequence);
      if (override instanceof Error) throw override;
      return (
        override ??
        Response.json(
          { event_id: body.event_id, status: sequence === 2 ? "accepted" : "duplicate" },
          { status: sequence === 1 ? 422 : 202, headers: { "x-request-id": randomUUID() } },
        )
      );
    },
  };
  return { records, calls, options, counts: () => ({ maxConcurrent, waits }) };
}

test("通常中継の1イベントだけを使い、63要求・並列2を越えない", async () => {
  const { records, calls, options, counts } = fixture();
  assert.equal(await runRelayLoad(options), true);
  assert.deepEqual(counts(), { maxConcurrent: 2, waits: 30 });
  assert.equal(calls.length, 63);
  assert.deepEqual(calls[0].body, {});
  const event = calls[1].body;
  assert.match(event.event_id, /^qa003-load-/);
  assert.equal(event.type, "follow");
  for (const { url, body, init } of calls.slice(1)) {
    assert.deepEqual(body, event);
    assert.equal(url, "https://notification-service.zunda-dev.workers.dev/v1/notifications");
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
  }
  assert.equal(records.filter((r) => r.outcome === "duplicate").length, 61);
  const ledger = JSON.stringify(records);
  assert.ok(!ledger.includes(token));
  assert.ok(!ledger.includes(event.event_id));
});

for (const status of [401, 409, 429, 503]) {
  test(`${status} を受けたら並行中の組の後で停止し、再試行しない`, async () => {
    const { calls, options, counts } = fixture(new Map([[4, new Response(null, { status })]]));
    assert.equal(await runRelayLoad(options), false);
    assert.equal(calls.length, 5);
    assert.equal(counts().waits, 1);
  });
}

test("重複確認が異常なら並行要求へ進まない", async () => {
  const { calls, options, counts } = fixture(
    new Map([[3, Response.json({ event_id: "different", status: "duplicate" }, { status: 202 })]]),
  );
  assert.equal(await runRelayLoad(options), false);
  assert.equal(calls.length, 3);
  assert.equal(counts().waits, 0);
});

test("タイムアウトなどの通信エラーは値を台帳に残さず停止する", async () => {
  const { calls, options, records } = fixture(new Map([[2, new Error(token)]]));
  assert.equal(await runRelayLoad(options), false);
  assert.equal(calls.length, 2);
  assert.equal(records.at(-1).outcome, "transport_error");
  assert.ok(!JSON.stringify(records).includes(token));
});

test("中止済みなら送らず、台帳へ予約できない要求も送らない", async () => {
  const { calls, options, records } = fixture();
  await assert.rejects(runRelayLoad({ ...options, signal: AbortSignal.abort() }));
  assert.equal(records.length, 0);
  await assert.rejects(
    runRelayLoad({
      ...options,
      record: async () => {
        throw new Error("ledger unavailable");
      },
    }),
  );
  assert.equal(calls.length, 0);
});

test("中継資格情報は保護された通常ファイルだけから読む", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-load-test-"));
  try {
    const path = join(directory, "token");
    const link = join(directory, "link");
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    assert.equal(await readRelayToken(path), token);
    await symlink(path, link);
    await assert.rejects(readRelayToken(link));
    await chmod(path, 0o644);
    await assert.rejects(readRelayToken(path), /private_token_file_required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("正規化した台帳の既存ファイルを守り、共有ディレクトリにも作らない", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "relay-load-ledger-"));
  try {
    const tokenPath = join(directory, "token");
    const ledgerPath = join(directory, "ledger");
    const shared = join(directory, "shared");
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    await mkdir(join(shared, "subdir"));
    await symlink(join(shared, "subdir"), join(directory, "link"));
    await writeFile(tokenPath, token, { mode: 0o600 });
    await writeFile(ledgerPath, "reserved", { mode: 0o600 });
    const script = fileURLToPath(new URL("./relay-load.mjs", import.meta.url));
    // HTTP 実装には到達しない。到達しても実ホストへ接続しないよう、通信権限を持たせない。
    for (const path of [`${directory}/link/../ledger`, join(shared, "ledger")]) {
      const result = spawnSync(process.execPath, [
        "--permission",
        `--allow-fs-read=${script}`,
        `--allow-fs-read=${directory}`,
        `--allow-fs-write=${directory}`,
        script,
        "--execute-sandbox",
        tokenPath,
        path,
      ]);
      assert.equal(result.status, 1);
    }
    assert.equal(await readFile(ledgerPath, "utf8"), "reserved");
    await assert.rejects(readFile(join(shared, "ledger")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
