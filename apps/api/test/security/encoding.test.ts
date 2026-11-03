import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../../src/security/encoding";

describe("Base64URL", () => {
  it("書いたものを読むと、元のバイト列に戻る", () => {
    for (const length of [0, 1, 2, 3, 32, 64, 65]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));

      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("同じバイト列の別の書き方 (使わないビットが 0 でない、余白の =、+ と /、空白) は読まない", () => {
    // 0xff は "_w"。"_x" は、使わない最後の 4 ビットだけが違い、atob では同じ 0xff になる。
    expect(fromBase64Url("_w")).toEqual(new Uint8Array([0xff]));

    for (const other of ["_x", "_w==", "/w", "_ w"]) {
      expect(fromBase64Url(other)).toBeUndefined();
    }
  });
});
