import { describe, expect, test } from "bun:test";

import "./test-preload.js";
import { isLoopbackPeer } from "../util/is-loopback-address.js";

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.local/v1/message", { headers });
}

function makeServer(address: string) {
  return {
    requestIP: () => ({ address, port: 12345 }),
  } as never;
}

describe("isLoopbackPeer — forwarded requests", () => {
  test("direct loopback peer without forwarding headers is loopback", () => {
    const req = makeReq();
    expect(isLoopbackPeer(makeServer("127.0.0.1"), req)).toBe(true);
  });

  test("loopback peer with X-Forwarded-For is not loopback", () => {
    const req = makeReq({ "x-forwarded-for": "127.0.0.1" });
    expect(isLoopbackPeer(makeServer("127.0.0.1"), req)).toBe(false);
  });

  test("loopback peer with standard forwarding headers is not loopback", () => {
    for (const header of [
      "forwarded",
      "via",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
      "x-real-ip",
    ]) {
      const req = makeReq({ [header]: "127.0.0.1" });
      expect(isLoopbackPeer(makeServer("127.0.0.1"), req)).toBe(false);
    }
  });

  test("non-loopback peer is not loopback", () => {
    const req = makeReq();
    expect(isLoopbackPeer(makeServer("203.0.113.9"), req)).toBe(false);
  });
});
