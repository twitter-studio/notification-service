import { describe, expect, it } from "vitest";
import { clientAddressKey, ipv6Prefix64 } from "../../src/security/rate-limit";

function keyOf(address?: string): string {
  return clientAddressKey(
    new Request("https://notification.test/", {
      headers: address === undefined ? {} : { "CF-Connecting-IP": address },
    }),
  );
}

describe("回数の制限で数える単位", () => {
  it("IPv6 は /64 ごとに数え、書き方 (省略、大文字、先頭の 0) が違っても同じ単位にする", () => {
    const key = keyOf("2001:db8:1:2::1");

    for (const same of [
      "2001:db8:1:2::1e",
      "2001:DB8:1:2:ffff:ffff:ffff:ffff",
      "2001:0db8:0001:0002:0:0:0:1",
      "2001:db8:1:2:0:0:192.0.2.1",
    ]) {
      expect(keyOf(same), same).toBe(key);
    }
    expect(keyOf("2001:db8:1:3::1")).not.toBe(key);
    expect(ipv6Prefix64("::1")).toBe("0:0:0:0");
    expect(ipv6Prefix64("2001:db8::")).toBe("2001:db8:0:0");
  });

  it("IPv4、読めない IPv6、IP がないときは、そのまま数える", () => {
    expect(keyOf("192.0.2.1")).toBe("ip:192.0.2.1");
    expect(keyOf("::ffff:192.0.2.1")).toBe("ip:192.0.2.1");
    expect(keyOf("192.0.2.2")).not.toBe(keyOf("192.0.2.1"));
    expect(keyOf("2001:db8::1::2")).toBe("ip:2001:db8::1::2");
    expect(keyOf("1:2:3")).toBe("ip:1:2:3");
    expect(keyOf()).toBe("ip:unknown");
  });
});
