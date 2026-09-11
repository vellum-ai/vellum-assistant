import { describe, expect, test } from "bun:test";

import {
  isCesHttpProbePath,
  isLoopbackAddress,
} from "./loopback-address.js";

describe("isLoopbackAddress", () => {
  test("accepts IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
  });

  test("accepts IPv6 loopback and IPv4-mapped loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects non-loopback addresses", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("2001:db8::1")).toBe(false);
  });
});

describe("isCesHttpProbePath", () => {
  test("matches kubelet probe paths only", () => {
    expect(isCesHttpProbePath("/healthz")).toBe(true);
    expect(isCesHttpProbePath("/readyz")).toBe(true);
    expect(isCesHttpProbePath("/v1/credentials")).toBe(false);
    expect(isCesHttpProbePath("/v1/logs/export")).toBe(false);
  });
});
