/**
 * Unit tests for the `client_os:` line in the unified-turn-context block.
 *
 * `interface` is the transport surface (always "web" for the web/iOS/macOS
 * apps, which share one renderer); `client_os` is the real OS, carried
 * separately so the model knows the platform without the OS perturbing
 * transport/host-proxy capability inference. These pin that both lines render
 * independently and that `client_os` is omitted when absent.
 */

import { describe, expect, test } from "bun:test";

import { buildUnifiedTurnContextBlock } from "../plugins/defaults/turn-context/unified-turn-context.js";

const TS = "2026-06-29T12:00:00.000Z";

describe("unified-turn-context client_os", () => {
  test("renders a client_os line alongside the transport interface", () => {
    const block = buildUnifiedTurnContextBlock({
      timestamp: TS,
      interfaceName: "web",
      clientOs: "macos",
    });
    expect(block).toContain("interface: web");
    expect(block).toContain("client_os: macos");
  });

  test("renders client_os: ios for the iOS app", () => {
    const block = buildUnifiedTurnContextBlock({
      timestamp: TS,
      interfaceName: "web",
      clientOs: "ios",
    });
    expect(block).toContain("client_os: ios");
  });

  test("omits client_os when not provided", () => {
    const block = buildUnifiedTurnContextBlock({
      timestamp: TS,
      interfaceName: "web",
    });
    expect(block).toContain("interface: web");
    expect(block).not.toContain("client_os:");
  });
});
