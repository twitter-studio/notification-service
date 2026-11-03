import { createApp } from "./app";
import { cleanupAcceptedEvents } from "./maintenance";

const app = createApp();

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      cleanupAcceptedEvents(env, controller.scheduledTime).then(
        (deleted) => console.log(JSON.stringify({ event: "accepted_events_cleanup", deleted })),
        (error: unknown) => {
          // エラーの文はログに出さない (app.ts の onError と同じ)。失敗は Cron の実行の記録に残す。
          console.error(
            JSON.stringify({
              event: "accepted_events_cleanup_failed",
              name: error instanceof Error ? error.name : "unknown",
            }),
          );
          throw error;
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
