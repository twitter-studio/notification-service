import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://notification-service.zunda-dev.workers.dev/v1/notifications";
const PAIRS = 30;
const INTERVAL_MS = 5_000;
const RUN_TIMEOUT_MS = 6 * 60_000;
const REQUEST_TIMEOUT_MS = 70_000;
const TOKEN = /^tsr_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function readRelayToken(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 128)
      throw new Error("private_token_file_required");
    const token = (await file.readFile("utf8")).trim();
    if (!TOKEN.test(token)) throw new Error("invalid_relay_token");
    return token;
  } finally {
    await file.close();
  }
}

async function relayResult(response, expected, eventId) {
  if (expected === "rejected" || response.status !== 202 || !response.body) {
    await response.body?.cancel();
    return expected === "rejected" && response.status === 422 ? expected : "unexpected";
  }
  const reader = response.body.getReader();
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) return "unexpected";
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body?.event_id === eventId && body.status === expected ? expected : "unexpected";
  } finally {
    await reader.cancel();
  }
}

export async function runRelayLoad({
  token,
  record,
  send = fetch,
  wait = (signal) => delay(INTERVAL_MS, undefined, { signal }),
  signal = AbortSignal.timeout(RUN_TIMEOUT_MS),
}) {
  if (!TOKEN.test(token)) throw new Error("invalid_relay_token");
  const event = {
    event_id: `qa003-load-${randomUUID()}`,
    type: "follow",
    occurred_at: new Date().toISOString(),
  };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let reserved = 0;
  async function batch(expected, count) {
    signal.throwIfAborted();
    await record({ stage: "reserved", expected, first: reserved + 1, count });
    reserved += count;
    signal.throwIfAborted();
    const body = JSON.stringify(expected === "rejected" ? {} : event);
    const results = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const sequence = reserved - count + index + 1;
        let status;
        let requestId;
        let outcome;
        try {
          const response = await send(ENDPOINT, {
            method: "POST",
            headers,
            body,
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
          status = response.status;
          const id = response.headers.get("x-request-id");
          if (REQUEST_ID.test(id ?? "")) requestId = id;
          outcome = await relayResult(response, expected, event.event_id);
        } catch {
          outcome = "transport_error";
        }
        return { stage: "result", sequence, status, request_id: requestId, outcome };
      }),
    );
    for (const result of results) await record(result);
    return results.every(({ outcome, request_id }) => outcome === expected && request_id);
  }

  if (!(await batch("rejected", 1))) return false;
  if (!(await batch("accepted", 1))) return false;
  // 202 accepted だけでは、重複の記録が完了したか分からない。
  if (!(await batch("duplicate", 1))) return false;
  for (let pair = 0; pair < PAIRS; pair++) {
    await wait(signal);
    if (!(await batch("duplicate", 2))) return false;
  }
  return true;
}

async function main([execute, tokenPath, ledgerPath, ...extra]) {
  if (execute !== "--execute-sandbox" || !tokenPath || !ledgerPath || extra.length)
    throw new Error("explicit_sandbox_execution_required");
  const requestedLedger = resolve(ledgerPath);
  const ledgerDirectory = await realpath(dirname(requestedLedger));
  if (((await stat(ledgerDirectory)).mode & 0o077) !== 0)
    throw new Error("private_ledger_directory_required");
  const token = await readRelayToken(tokenPath);
  const ledger = await open(join(ledgerDirectory, basename(requestedLedger)), "wx", 0o600);
  const record = async (value) => {
    await ledger.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
    await ledger.sync();
  };
  try {
    const complete = await runRelayLoad({ token, record });
    await record({ stage: "finished", complete });
    if (!complete) process.exitCode = 1;
  } finally {
    await ledger.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("Relay load stopped. Check the private ledger before any new run.\n");
    process.exitCode = 1;
  });
}
