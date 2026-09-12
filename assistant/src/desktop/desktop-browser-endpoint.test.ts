import { expect, test } from "bun:test";

import { validateDesktopWebSocket } from "./desktop-browser-endpoint.js";

test("discovery only accepts the allocated loopback browser endpoint", () => {
  expect(
    validateDesktopWebSocket(
      "ws://127.0.0.1:9222/devtools/browser/abc-123",
      9222,
    ),
  ).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
  for (const endpoint of [
    "ws://example.com:9222/devtools/browser/abc",
    "ws://127.0.0.1:9223/devtools/browser/abc",
    "ws://user:password@127.0.0.1:9222/devtools/browser/abc",
    "ws://127.0.0.1:9222/devtools/page/abc",
    "ws://127.0.0.1:9222/devtools/browser/abc?redirect=1",
    "ws://127.0.0.1:9222/devtools/browser/abc#fragment",
    undefined,
  ]) {
    expect(() => validateDesktopWebSocket(endpoint, 9222)).toThrow();
  }
});
