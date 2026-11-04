import { campaignResults, gateway, type LabEnv, startCampaign } from "../qa/fixtures";

function configured(env: LabEnv) {
  const deadline = Number(env.QA_DEADLINE);
  return (
    env.QA_MODE === "isolated-synthetic" &&
    /^qa_[A-Za-z0-9_-]{43}$/.test(env.QA_ADMIN_TOKEN) &&
    Number.isSafeInteger(deadline) &&
    deadline > Date.now() &&
    deadline <= Date.now() + 2 * 60 * 60 * 1000
  );
}
async function authorized(request: Request, env: LabEnv) {
  const supplied = /^Bearer (qa_[A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("Authorization") ?? "",
  )?.[1];
  if (!supplied) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const expected = await digest(env.QA_ADMIN_TOKEN),
    actual = await digest(supplied);
  return expected.every((byte, index) => byte === actual[index]);
}
const response = (body: object, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request: Request, env: LabEnv) {
    if (!configured(env)) return response({ status: "unavailable" }, 503);
    if (!(await env.QA_RATE_LIMITER.limit({ key: "qa-global" })).success)
      return response({ status: "rate_limited" }, 429);
    if (!(await authorized(request, env))) return response({ status: "unauthorized" }, 401);
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/start") {
        await request.body?.cancel();
        const started = await startCampaign(env);
        return response(
          { status: started ? "started" : "already_started", case_count: 8 },
          started ? 202 : 409,
        );
      }
      if (request.method === "GET" && path === "/results")
        return response(await campaignResults(env));
      return response({ status: "not_found" }, 404);
    } catch {
      return response({ status: "failed" }, 500);
    }
  },
  async queue(batch, env) {
    if (batch.queue !== "notification-qa-faults") throw new Error("qa_queue_scope_invalid");
    if (!configured(env)) {
      for (const message of batch.messages) message.ack();
      return;
    }
    try {
      await gateway(env).consume(batch);
    } catch {
      throw new Error("qa_queue_failed");
    }
  },
} satisfies ExportedHandler<LabEnv>;
