import { createApp } from "./app";
import { cleanupAcceptedEvents, cleanupExpiredAuthRecords } from "./maintenance";

const app = createApp();

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        cleanupAcceptedEvents(env, controller.scheduledTime),
        cleanupExpiredAuthRecords(env, controller.scheduledTime),
      ]).then(
        ([acceptedEvents, authRecords]) =>
          console.log(
            JSON.stringify({
              event: "cleanup",
              accepted_events: acceptedEvents,
              auth_records: authRecords,
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
