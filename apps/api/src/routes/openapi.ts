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

/** 待ってやり直せるエラー。待つ秒数は入口と理由ごとに違うので、Retry-After で返す。 */
export const retryableProblemResponse = (description: string) => ({
  ...problemResponse(description),
  headers: {
    "Retry-After": {
      description: "やり直すまで待つ秒数",
      required: true,
      schema: { type: "integer" as const, minimum: 0 },
    },
  },
});

/** どの入口でも返しうるエラー。 */
export const commonProblems = {
  400: problemResponse("本文が JSON として読めない"),
  413: problemResponse("本文が 4 KiB を超える"),
  415: problemResponse("Content-Type が application/json でない"),
  422: problemResponse("入力の誤り"),
  429: retryableProblemResponse("回数の制限を超えた"),
  500: problemResponse("サーバーの誤り"),
};

const SESSION_UNAUTHORIZED =
  "セッションがない、または使えない (WWW-Authenticate を付ける。セッションを作り直す)";

/** アカウントのセッションが要る入口で返しうるエラー。 */
export const sessionProblems = {
  401: problemResponse(SESSION_UNAUTHORIZED),
};

/** セッションに加えて、端末の鍵の署名でも確かめる入口で返しうるエラー。 */
export const signedSessionProblems = {
  401: problemResponse(
    `${SESSION_UNAUTHORIZED}。WWW-Authenticate がなければ、チャレンジか署名が正しくないか、インストールが使えない (セッションを作り直しても直らない)`,
  ),
};

/**
 * サーバーが返した ID を送る欄。返した文字列 (小文字の UUID) をそのまま送る。
 * サーバーで小文字にそろえないのは、インストールの ID が署名する文に入り、送られた文字のまま確かめるため。
 */
export const idSchema = (description: string) =>
  z.uuid().openapi({
    description: `${description}。サーバーが返した文字列 (小文字の UUID) をそのまま送る`,
  });

/** 端末の鍵の署名で確かめる入口の本文。チャレンジは用途ごとに出したもの。 */
export const InstallationProofSchema = z
  .object({ challenge: z.string().max(512), signature: z.string().max(128) })
  .openapi("InstallationProof");
