import { describe, expect, test } from "bun:test";

import { resolveClientIp } from "./rate-limit";

describe("resolveClientIp", () => {
  test("uses the second-to-last hop (real client behind the load balancer)", () => {
    expect(resolveClientIp("203.0.113.7, 10.0.0.1")).toBe("203.0.113.7");
    expect(resolveClientIp("198.51.100.2, 203.0.113.7, 10.0.0.1")).toBe(
      "203.0.113.7",
    );
  });

  test("trims whitespace around entries", () => {
    expect(resolveClientIp("  203.0.113.7 ,  10.0.0.1 ")).toBe("203.0.113.7");
  });

  test("falls back to the only entry for a single-hop header", () => {
    expect(resolveClientIp("203.0.113.7")).toBe("203.0.113.7");
  });

  test("returns unknown for missing or garbage input", () => {
    expect(resolveClientIp(null)).toBe("unknown");
    expect(resolveClientIp("")).toBe("unknown");
    expect(resolveClientIp(",")).toBe("unknown");
    expect(resolveClientIp(" , ")).toBe("unknown");
  });
});
