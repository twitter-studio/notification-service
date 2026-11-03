import { createApp } from "./app";
import {
  cleanupAbandonedAccounts,
  cleanupAcceptedEvents,
  cleanupExpiredAuthRecords,
  cleanupStaleDevices,
} from "./maintenance";

const app = createApp();

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        cleanupAcceptedEvents(env, controller.scheduledTime),
        cleanupExpiredAuthRecords(env, controller.scheduledTime),
        cleanupStaleDevices(env, controller.scheduledTime),
        cleanupAbandonedAccounts(env, controller.scheduledTime),
      ]).then(
        ([acceptedEvents, authRecords, staleDevices, abandonedAccounts]) =>
          console.log(
            JSON.stringify({
              event: "cleanup",
              accepted_events: acceptedEvents,
              auth_records: authRecords,
              stale_devices: staleDevices,
              abandoned_accounts: abandonedAccounts,
            }),
          ),
        (error: unknown) => {
          // エラーの文はログに出さない (app.ts の onError と同じ)。元のエラーを投げ直すと、ランタイムが文ごと記録するので、
          // 決まった文のエラーを投げて、Cron の実行を失敗として残す。
          console.error(
            JSON.stringify({
              event: "cleanup_failed",
              name: error instanceof Error ? error.name : "unknown",
            }),
          );
          throw new Error("cleanup_failed");
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
