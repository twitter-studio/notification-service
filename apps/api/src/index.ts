import { createApp } from "./app";
import { cleanupAcceptedEvents } from "./maintenance";

const app = createApp();

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      cleanupAcceptedEvents(env, controller.scheduledTime).then(
        (result) => console.log(JSON.stringify({ event: "accepted_events_cleanup", ...result })),
        (error: unknown) => {
          // エラーの文はログに出さない (app.ts の onError と同じ)。元のエラーを投げ直すと、ランタイムが文ごと記録するので、
          // 決まった文のエラーを投げて、Cron の実行を失敗として残す。
          console.error(
            JSON.stringify({
              event: "accepted_events_cleanup_failed",
              name: error instanceof Error ? error.name : "unknown",
            }),
          );
          throw new Error("accepted_events_cleanup_failed");
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
