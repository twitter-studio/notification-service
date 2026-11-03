import { createApp } from "./app";
import {
  cleanupAbandonedAccounts,
  cleanupAcceptedEvents,
  cleanupExpiredAuthRecords,
  cleanupStaleDevices,
} from "./maintenance";

const app = createApp();

/**
 * Cron の式ごとの掃除 (wrangler.jsonc の triggers.crons と同じ)。1 回の呼び出しで D1 に投げる問い合わせの数に上限があるので
 * (無料のプランで 50)、掃除ごとに呼び出しを分ける。
 */
const CLEANUPS: Record<
  string,
  { name: string; run: (env: Env, time: number) => Promise<unknown> }
> = {
  "17 18 * * *": { name: "accepted_events", run: cleanupAcceptedEvents },
  "27 18 * * *": { name: "auth_records", run: cleanupExpiredAuthRecords },
  "37 18 * * *": { name: "stale_devices", run: cleanupStaleDevices },
  "47 18 * * *": { name: "abandoned_accounts", run: cleanupAbandonedAccounts },
};

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const cleanup = CLEANUPS[controller.cron];
    if (cleanup === undefined) {
      // wrangler.jsonc と CLEANUPS がずれている。式は秘密ではないので、ログに出す。
      console.error(JSON.stringify({ event: "unknown_cron", cron: controller.cron }));
      throw new Error("unknown_cron");
    }
    ctx.waitUntil(
      cleanup.run(env, controller.scheduledTime).then(
        (result) =>
          console.log(JSON.stringify({ event: "cleanup", cleanup: cleanup.name, result })),
        (error: unknown) => {
          // エラーの文はログに出さない (app.ts の onError と同じ)。元のエラーを投げ直すと、ランタイムが文ごと記録するので、
          // 決まった文のエラーを投げて、Cron の実行を失敗として残す。
          console.error(
            JSON.stringify({
              event: "cleanup_failed",
              cleanup: cleanup.name,
              name: error instanceof Error ? error.name : "unknown",
            }),
          );
          throw new Error("cleanup_failed");
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
