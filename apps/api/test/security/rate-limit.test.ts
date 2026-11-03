import { describe, expect, it } from "vitest";
import { clientAddressKey, parseIpv6 } from "../../src/security/rate-limit";

function keyOf(address?: string): string {
  return clientAddressKey(
    new Request("https://notification.test/", {
      headers: address === undefined ? {} : { "CF-Connecting-IP": address },
    }),
  );
}

describe("回数の制限で数える単位", () => {
  it("IPv6 は /64 ごとに数え、書き方 (省略、大文字、先頭の 0、末尾の IPv4) が違っても同じ単位にする", () => {
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
  });

  it("IPv4 を写した IPv6 と NAT64 は、書き方によらず IPv4 として数える", () => {
    for (const same of [
      "192.0.2.1",
      "::ffff:192.0.2.1",
      "::FFFF:c000:201",
      "0:0:0:0:0:ffff:192.0.2.1",
      "64:ff9b::192.0.2.1",
    ]) {
      expect(keyOf(same), same).toBe("ip:192.0.2.1");
    }
    expect(keyOf("::ffff:192.0.2.2")).toBe("ip:192.0.2.2");
  });

  it("前の 64 ビットが 0 のアドレスはまとめず、アドレスごとに数える", () => {
    expect(keyOf("::192.0.2.1")).not.toBe(keyOf("::192.0.2.2"));
    expect(keyOf("::1")).not.toBe(keyOf("::2"));
    expect(keyOf("::1")).toBe(keyOf("0:0:0:0:0:0:0:1"));
  });

  it("読めない書き方と、IP がないときは、値のまま数える", () => {
    for (const unreadable of [
      "2001:db8::1::2",
      "1:2:3",
      "::ffff:192.0.2.256",
      "::g",
      "1:2:3:4:5:6:7:8:9",
    ]) {
      expect(parseIpv6(unreadable), unreadable).toBeUndefined();
      expect(keyOf(unreadable)).toBe(`ip:${unreadable}`);
    }
    expect(keyOf()).toBe("ip:unknown");
  });
});
