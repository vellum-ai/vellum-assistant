import { describe, expect, test } from "bun:test";

import { faviconUrlForDomain } from "../favicon.js";

describe("faviconUrlForDomain", () => {
  test("returns a properly encoded s2 URL for a valid host", () => {
    expect(faviconUrlForDomain("example.com")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
  });

  test("lowercases mixed-case hosts before encoding", () => {
    expect(faviconUrlForDomain("Example.COM")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
  });

  test("returns undefined for empty input", () => {
    expect(faviconUrlForDomain("")).toBeUndefined();
  });

  test("returns undefined for whitespace-only input", () => {
    expect(faviconUrlForDomain("   ")).toBeUndefined();
  });

  test("returns undefined for hosts containing a slash", () => {
    expect(faviconUrlForDomain("example.com/path")).toBeUndefined();
  });

  test("returns undefined for hosts containing a space", () => {
    expect(faviconUrlForDomain("example .com")).toBeUndefined();
  });

  test("URL-encodes unicode/IDN hosts", () => {
    // Punycode-style raw unicode host should be percent-encoded by encodeURIComponent.
    const result = faviconUrlForDomain("münchen.de");
    expect(result).toBe(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent("münchen.de")}&sz=64`,
    );
    // Sanity check: the encoded form contains percent-encoded bytes for "ü".
    expect(result).toContain("m%C3%BCnchen.de");
  });

  test("returns undefined for localhost", () => {
    expect(faviconUrlForDomain("localhost")).toBeUndefined();
  });

  test("returns undefined for private IPv4 hosts", () => {
    expect(faviconUrlForDomain("127.0.0.1")).toBeUndefined();
    expect(faviconUrlForDomain("10.0.0.5")).toBeUndefined();
    expect(faviconUrlForDomain("192.168.1.1")).toBeUndefined();
  });

  test("returns undefined for raw IP literals (we don't reverse-lookup, so any IP is private-equivalent for our purposes)", () => {
    // isPrivateOrLocalHost rejects raw IP literals because we can't tell from
    // the host alone whether they belong to a routable public host. Skipping
    // favicons for them avoids leaking internal IPs.
    expect(faviconUrlForDomain("172.16.0.1")).toBeUndefined();
  });

  test("strips :port before the private-host check (host:port → undefined for private)", () => {
    expect(faviconUrlForDomain("localhost:3000")).toBeUndefined();
    expect(faviconUrlForDomain("127.0.0.1:8080")).toBeUndefined();
    expect(faviconUrlForDomain("192.168.1.1:443")).toBeUndefined();
  });

  test("strips :port and encodes only the host (public host with port)", () => {
    const result = faviconUrlForDomain("example.com:8080");
    expect(result).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
  });

  test("handles bracketed IPv6 hosts with ports", () => {
    expect(faviconUrlForDomain("[::1]:8080")).toBeUndefined();
  });
});
