import { ApnsClient } from "./apns/client";
import { ApnsPushGateway } from "./apns/gateway";
import { createApp } from "./app";
import {
  cleanupAbandonedAccounts,
  cleanupAcceptedEvents,
  cleanupExpiredAuthRecords,
  cleanupStaleDevices,
} from "./maintenance";
import {
  publicOperationEnabled,
  type RuntimeEnv,
  requireDeliveryEnabled,
  trialAllowsRelay,
} from "./operations";
import { recordQueueMetrics } from "./queue-metrics";
import { recordTelemetry } from "./telemetry";

let currentClient: { configuration: string | undefined; client: ApnsClient } | undefined;
const applications = new WeakMap<
  RuntimeEnv,
  { app: ReturnType<typeof createApp>; gateway: ApnsPushGateway; configuration: string | undefined }
>();
function application(env: RuntimeEnv) {
  const configuration = env.APNS_PROVIDER_KEYS;
  if (currentClient === undefined || currentClient.configuration !== configuration)
    currentClient = { configuration, client: new ApnsClient(configuration) };
  let value = applications.get(env);
  if (value === undefined || value.configuration !== configuration) {
    const client =
      env.PUBLIC_TRIAL === undefined
        ? currentClient.client
        : new ApnsClient(configuration, {
            send: (request, init) => {
              requireDeliveryEnabled(env);
              return fetch(request, init);
            },
          });
    const gateway = new ApnsPushGateway(env, { client });
    value = {
      configuration,
      gateway,
      app: createApp({
        push: gateway.push,
        sendDeviceVerification: gateway.sendDeviceVerification,
      }),
    };
    applications.set(env, value);
  }
  return value;
}

/** 定期の掃除の Cron の式 (wrangler.jsonc の triggers.crons と同じ)。1 つの式で、4 つの分に発火させる。 */
const CLEANUP_CRON = "17,27,37,47 18 * * *";

/**
 * 発火した分ごとの掃除。1 回の呼び出しで D1 に投げる問い合わせの数に上限があるので (無料のプランで 50)、掃除ごとに呼び出しを分ける。
 * 式を 1 つにまとめ、無料のプランの Cron の枠 (アカウントに 5 つ) を 1 つしか使わない。
 */
const CLEANUPS: Record<
  number,
  { name: string; run: (env: Env, time: number) => Promise<unknown> }
> = {
  17: { name: "accepted_events", run: cleanupAcceptedEvents },
  27: { name: "auth_records", run: cleanupExpiredAuthRecords },
  37: { name: "stale_devices", run: cleanupStaleDevices },
  47: { name: "abandoned_accounts", run: cleanupAbandonedAccounts },
};

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch(request, env, ctx) {
    try {
      return application(env).app.fetch(request, env, ctx);
    } catch {
      console.error(JSON.stringify({ event: "apns_configuration_invalid" }));
      return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv) {
    try {
      if (!publicOperationEnabled(env, "PUBLIC_DELIVERY_ENABLED")) {
        for (const message of batch.messages) {
          recordTelemetry({ event: "delivery_discarded", reason: "operations_paused" });
          message.ack();
        }
        return;
      }
      await application(env).gateway.consume(batch, {
        allowRelay: (credentialId, type) => trialAllowsRelay(env, credentialId, type),
      });
    } catch {
      console.error(JSON.stringify({ event: "apns_queue_configuration_invalid" }));
      for (const message of batch.messages) {
        if (message.attempts < 2) message.retry({ delaySeconds: 900 });
        else message.ack();
      }
    }
  },
  async scheduled(controller, env, ctx) {
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(recordQueueMetrics(env.APNS_RETRIES, controller.scheduledTime));
      return;
    }
    const cleanup =
      controller.cron === CLEANUP_CRON
        ? CLEANUPS[new Date(controller.scheduledTime).getUTCMinutes()]
        : undefined;
    if (cleanup === undefined) {
      // 構成の不一致だけを記録し、渡された式の値は残さない。
      console.error(JSON.stringify({ event: "unknown_cron" }));
      throw new Error("unknown_cron");
    }
    ctx.waitUntil(
      cleanup.run(env, controller.scheduledTime).then(
        (result) =>
          console.log(JSON.stringify({ event: "cleanup", cleanup: cleanup.name, result })),
        () => {
          // エラーの文はログに出さない (app.ts の onError と同じ)。元のエラーを投げ直すと、ランタイムが文ごと記録するので、
          // 決まった文のエラーを投げて、Cron の実行を失敗として残す。
          console.error(
            JSON.stringify({
              event: "cleanup_failed",
              cleanup: cleanup.name,
            }),
          );
          throw new Error("cleanup_failed");
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
