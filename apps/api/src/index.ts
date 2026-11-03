import { createApp } from "./app";
import { cleanupAcceptedEvents } from "./maintenance";

const app = createApp();

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      cleanupAcceptedEvents(env, controller.scheduledTime).then((deleted) =>
        console.log(JSON.stringify({ event: "accepted_events_cleanup", deleted })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
