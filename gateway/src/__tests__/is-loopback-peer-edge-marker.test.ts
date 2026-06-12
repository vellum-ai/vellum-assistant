/**
 * Tests for the edge-forwarded marker handling in `isLoopbackPeer`.
 *
 * Requests proxied by the self-hosted nginx ingress arrive over a chain whose
 * every hop is loopback (browser → tunnel agent → nginx → gateway), so neither
 * the raw socket peer nor X-Forwarded-For can prove locality. nginx stamps the
 * unspoofable `X-Vellum-Edge-Forwarded` marker; the gateway must treat any
 * marker-carrying request as non-loopback regardless of XFF — including the
 * spoof case where a remote caller sends `X-Forwarded-For: 127.0.0.1` and an
 * appending tunnel keeps it as the leftmost entry.
 */

import { describe, expect, test } from "bun:test";

import "./test-preload.js";
import { EDGE_FORWARDED_HEADER } from "../http/edge-forwarded-header.js";
import { isLoopbackPeer } from "../util/is-loopback-address.js";

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.local/v1/message", { headers });
}

function makeServer(address: string) {
  return {
    requestIP: () => ({ address, port: 12345 }),
  } as never;
}

describe("isLoopbackPeer — edge-forwarded marker", () => {
  test("marker present: never loopback, even from a loopback peer", () => {
    const req = makeReq({ [EDGE_FORWARDED_HEADER]: "1" });
    expect(isLoopbackPeer(makeServer("127.0.0.1"), req)).toBe(false);
    expect(
      isLoopbackPeer(makeServer("127.0.0.1"), req, { trustProxy: true }),
    ).toBe(false);
  });

  test("marker + spoofed XFF 127.0.0.1: still not loopback under trustProxy", () => {
    // The exact attack the marker exists for: a remote caller forges a
    // loopback leftmost X-Forwarded-For entry through the tunnel + nginx
    // chain, where the raw socket peer is genuinely 127.0.0.1.
    const req = makeReq({
      [EDGE_FORWARDED_HEADER]: "1",
      "x-forwarded-for": "127.0.0.1",
    });
    expect(
      isLoopbackPeer(makeServer("127.0.0.1"), req, { trustProxy: true }),
    ).toBe(false);
  });

  test("no marker: direct loopback peer is still loopback", () => {
    const req = makeReq();
    expect(isLoopbackPeer(makeServer("127.0.0.1"), req)).toBe(true);
    expect(
      isLoopbackPeer(makeServer("127.0.0.1"), req, { trustProxy: true }),
    ).toBe(true);
  });

  test("no marker, trustProxy: loopback peer with loopback XFF keeps the documented proxy contract", () => {
    // Unchanged behavior for proxies that overwrite XFF (the documented
    // trustProxy requirement) and forward a genuinely local client.
    const req = makeReq({ "x-forwarded-for": "127.0.0.1" });
    expect(
      isLoopbackPeer(makeServer("127.0.0.1"), req, { trustProxy: true }),
    ).toBe(true);
  });

  test("no marker: non-loopback peer is never loopback", () => {
    const req = makeReq();
    expect(isLoopbackPeer(makeServer("203.0.113.9"), req)).toBe(false);
    expect(
      isLoopbackPeer(makeServer("203.0.113.9"), req, { trustProxy: true }),
    ).toBe(false);
  });
});
