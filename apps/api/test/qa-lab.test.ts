import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CASES, type LabEnv, TOPIC } from "../qa/fixtures";
import lab from "../src/qa-lab";
import { signingConfiguration } from "./helpers/apns";

async function setup() {
  await applyD1Migrations(env.QA_DB, env.QA_MIGRATIONS);
  const signing = await signingConfiguration();
  const jobs: unknown[] = [];
  const queue = {
    ...env.APNS_RETRIES,
    async send(body: unknown) {
      jobs.push(body);
      return { metadata: { metrics: { backlogCount: jobs.length, backlogBytes: 100 } } };
    },
  };
  const configuration: LabEnv = {
    ...env,
    DB: env.QA_DB,
    APNS_RETRIES: queue,
    APNS_PROVIDER_KEYS: JSON.stringify([{ ...signing.configuration, topic: TOPIC }]),
    QA_MODE: "isolated-synthetic",
    QA_ADMIN_TOKEN: `qa_${"a".repeat(43)}`,
    QA_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    QA_DEADLINE: String(Date.now() + 90 * 60 * 1000),
  };
  const request = (path: string, method = "GET") =>
    new Request(`https://qa.invalid${path}`, {
      method,
      headers: { Authorization: `Bearer ${configuration.QA_ADMIN_TOKEN}` },
    });
  return { configuration, request, jobs };
}

describe("隔離した障害試験", () => {
  it("認証と期限を確認し、一度の開始だけで8ケースを作り、再送停止と打ち切りを検証できる", async () => {
    const { configuration, request, jobs } = await setup();
    expect((await lab.fetch(new Request("https://qa.invalid/results"), configuration)).status).toBe(
      401,
    );
    expect(
      (await lab.fetch(request("/start", "POST"), { ...configuration, QA_DEADLINE: "0" })).status,
    ).toBe(503);
    expect(
      (
        await lab.fetch(request("/results"), {
          ...configuration,
          QA_ADMIN_TOKEN: `qa_${"b".repeat(43)}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await lab.fetch(request("/results"), {
          ...configuration,
          QA_RATE_LIMITER: {
            async limit() {
              return { success: false };
            },
          },
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await lab.fetch(request("/start", "POST"), {
          ...configuration,
          APNS_PROVIDER_KEYS: "[]",
        })
      ).status,
    ).toBe(500);
    expect((await lab.fetch(request("/start", "POST"), configuration)).status).toBe(202);
    expect((await lab.fetch(request("/start", "POST"), configuration)).status).toBe(409);
    expect(jobs).toHaveLength(5);
    const consume = async (body: unknown, attempts: number) => {
      const batch = createMessageBatch("notification-qa-faults", [
        { id: crypto.randomUUID(), timestamp: new Date(), body, attempts },
      ]);
      await lab.queue(batch, configuration);
      return getQueueResult(batch, createExecutionContext());
    };
    for (const job of jobs) await consume(job, 1);
    const first = await configuration.DB.prepare(
      "SELECT name,COUNT(*) AS count FROM qa_attempts GROUP BY name",
    ).all<{ name: string; count: number }>();
    expect(first.results.find((row) => row.name === "exhaust503")?.count).toBe(2);
    for (const name of ["disabled", "revoked", "rotated"])
      expect(first.results.find((row) => row.name === name)?.count).toBe(1);
    expect(first.results.find((row) => row.name === "recover429")?.count).toBe(2);
    // Queue自体の再配信はローカルでは待たず、実物のバッチのattemptsだけを進める。
    await consume(jobs[1], 2);
    const result = await lab.fetch(request("/results"), configuration);
    expect(result.status).toBe(200);
    const report = await result.json<{
      attempts: { name: string; status: number }[];
      states: { name: string; state: string }[];
    }>();
    expect(
      report.attempts.filter((row) => row.name === "exhaust503").map((row) => row.status),
    ).toEqual([503, 503, 503]);
    expect(
      report.states
        .filter((row) => row.name.endsWith("400") || row.name.endsWith("410"))
        .map((row) => row.state),
    ).toEqual(["invalidated", "invalidated"]);
    expect(report.states).toHaveLength(CASES.length);
    const expired = createMessageBatch("notification-qa-faults", [
      {
        id: "expired",
        timestamp: new Date(),
        body: jobs[1],
        attempts: 1,
      },
    ]);
    await lab.queue(expired, { ...configuration, QA_DEADLINE: "0" });
    expect((await getQueueResult(expired, createExecutionContext())).explicitAcks).toEqual([
      "expired",
    ]);
    expect(await (await lab.fetch(request("/results"), configuration)).json()).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("PRIVATE KEY");
  });
});
