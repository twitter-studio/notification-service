import { z } from "@hono/zod-openapi";

// 入口どうしで共通の OpenAPI の部品。

const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    request_id: z.string(),
  })
  .openapi("Problem");

export const problemResponse = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** どの入口でも返しうるエラー。 */
export const commonProblems = {
  400: problemResponse("本文が JSON として読めない"),
  413: problemResponse("本文が 4 KiB を超える"),
  415: problemResponse("Content-Type が application/json でない"),
  422: problemResponse("入力の誤り"),
  429: problemResponse("回数の制限を超えた (Retry-After の秒数を待つ)"),
  500: problemResponse("サーバーの誤り"),
};

/** アカウントのセッションが要る入口で返しうるエラー。 */
export const sessionProblems = {
  401: problemResponse("セッションがない、または使えない (WWW-Authenticate を付ける)"),
};

/** 端末の鍵の署名で確かめる入口の本文。チャレンジは用途ごとに出したもの。 */
export const InstallationProofSchema = z
  .object({ challenge: z.string().max(512), signature: z.string().max(128) })
  .openapi("InstallationProof");
