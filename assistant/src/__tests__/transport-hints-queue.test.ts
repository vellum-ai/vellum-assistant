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
  test("returns empty array for macOS transport without client hints", () => {
    const transport: MacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toHaveLength(0);
  });

  test("returns empty array for non-macOS transport without client hints", () => {
    const transport: NonMacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "ios",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toHaveLength(0);
  });

  test("forwards client-provided hints", () => {
    const transport: MacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/bob",
      hostUsername: "bob",
      hints: ["custom hint"],
    };

    const hints = buildTransportHints(transport);

    expect(hints).toEqual(["custom hint"]);
  });

  test("returns empty array when no hints field present", () => {
    const transport: MacosTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toHaveLength(0);
  });
});
