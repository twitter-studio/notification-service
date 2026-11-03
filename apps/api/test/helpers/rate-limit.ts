import { expect } from "vitest";

/**
 * 回数の制限に届くまで `attempt` をくり返し、届いたことと、届くまでに通った回数を確かめる。
 *
 * Miniflare の Rate Limiting は、時計にそろえた区切り (60 秒) ごとに数え直す。テストが区切りをまたぐと数が 0 に戻るので、
 * 「6 回目が 429」とは決められない。テストは 1 つの区切りより短いので、またぐのは 1 回まで。通った回数は、上限から上限の
 * 2 倍のあいだになる。
 */
export async function expectLimitReached(
  limit: number,
  attempt: () => Promise<"passed" | "limited">,
): Promise<void> {
  const outcomes: string[] = [];
  for (let index = 0; index < limit * 2 + 1; index++) {
    const outcome = await attempt();
    outcomes.push(outcome);
    if (outcome === "limited") break;
  }
  expect(outcomes.at(-1), outcomes.join(",")).toBe("limited");
  expect(outcomes.length - 1, outcomes.join(",")).toBeGreaterThanOrEqual(limit);
}

/** 応答の状態から、`expectLimitReached` の結果にする。通ったときの状態でも、429 でもなければ、テストを失敗にする。 */
export function outcomeOf(status: number, passed: number): "passed" | "limited" {
  if (status === 429) return "limited";
  expect(status).toBe(passed);
  return "passed";
}
