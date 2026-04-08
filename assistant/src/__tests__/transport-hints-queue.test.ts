import { describe, expect, test } from "bun:test";

import type {
  HostProxyTransportMetadata,
  NonHostProxyTransportMetadata,
} from "../daemon/message-types/conversations.js";
import { buildTransportHints } from "../daemon/transport-hints.js";

// ---------------------------------------------------------------------------
// buildTransportHints
// ---------------------------------------------------------------------------

describe("buildTransportHints", () => {
  test("returns empty array for host-proxy transport without client hints", () => {
    const transport: HostProxyTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toHaveLength(0);
  });

  test("returns empty array for non-host-proxy transport without client hints", () => {
    const transport: NonHostProxyTransportMetadata = {
      channelId: "vellum",
      interfaceId: "ios",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toHaveLength(0);
  });

  test("forwards client-provided hints", () => {
    const transport: HostProxyTransportMetadata = {
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
    const transport: HostProxyTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
    };

    const hints = buildTransportHints(transport);

    expect(hints).toHaveLength(0);
  });
});
