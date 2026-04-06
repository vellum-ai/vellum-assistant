import { describe, expect, test } from "bun:test";

import type {
  MacosTransportMetadata,
  NonMacosTransportMetadata,
} from "../daemon/message-types/conversations.js";
import { buildTransportHints } from "../daemon/transport-hints.js";

// ---------------------------------------------------------------------------
// buildTransportHints
// ---------------------------------------------------------------------------

describe("buildTransportHints", () => {
  test("produces correct hints for macOS transport", () => {
    const transport: MacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toContain("User is messaging from interface: macos");
    expect(hints).toContain("Host home directory: /Users/alice");
    expect(hints).toContain("Host username: alice");
    expect(hints).toHaveLength(3);
  });

  test("produces correct hints for non-macOS transport", () => {
    const transport: NonMacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "ios",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toContain("User is messaging from interface: ios");
    expect(hints).toHaveLength(1);
    // Should not include host environment hints
    expect(hints.some((h) => h.includes("Host home directory"))).toBe(false);
    expect(hints.some((h) => h.includes("Host username"))).toBe(false);
  });

  test("includes client-provided hints", () => {
    const transport: MacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/bob",
      hostUsername: "bob",
      hints: ["custom hint"],
    };

    const hints = buildTransportHints(transport);

    expect(hints).toContain("User is messaging from interface: macos");
    expect(hints).toContain("Host home directory: /Users/bob");
    expect(hints).toContain("Host username: bob");
    expect(hints).toContain("custom hint");
    expect(hints).toHaveLength(4);
  });

  test("handles missing optional fields on macOS transport", () => {
    const transport: MacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toContain("User is messaging from interface: macos");
    // Without hostHomeDir and hostUsername, only the interface hint is present
    expect(hints).toHaveLength(1);
    expect(hints.some((h) => h.includes("Host home directory"))).toBe(false);
    expect(hints.some((h) => h.includes("Host username"))).toBe(false);
  });
});
