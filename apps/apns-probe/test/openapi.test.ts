import { expect, it } from "vitest";
import { openApiDocument } from "../src/app";

it("検証専用の認証付きAPIの契約が生成文書と一致する", async () => {
  await expect(`${JSON.stringify(openApiDocument(), null, 2)}\n`).toMatchFileSnapshot(
    "../openapi.json",
  );
});
