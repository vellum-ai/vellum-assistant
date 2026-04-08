import { describe, expect, test } from "bun:test";

import type { HostProxyInterfaceId, InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import type {
  ConversationTransportMetadata,
  HostProxyTransportMetadata,
  NonHostProxyTransportMetadata,
} from "../daemon/message-types/conversations.js";

// ---------------------------------------------------------------------------
// supportsHostProxy — runtime behavior
// ---------------------------------------------------------------------------

describe("supportsHostProxy (runtime)", () => {
  test("no-arg form returns true for host-proxy interfaces", () => {
    expect(supportsHostProxy("macos")).toBe(true);
  });

  test("no-arg form returns false for interfaces without host-proxy support", () => {
    const nonHostProxyIds: InterfaceId[] = [
      "ios",
      "cli",
      "telegram",
      "phone",
      "vellum",
      "whatsapp",
      "slack",
      "email",
      "chrome-extension",
    ];
    for (const id of nonHostProxyIds) {
      expect(supportsHostProxy(id)).toBe(false);
    }
  });

  test("capability form grants host_browser to chrome-extension", () => {
    expect(supportsHostProxy("chrome-extension", "host_browser")).toBe(true);
    expect(supportsHostProxy("chrome-extension", "host_bash")).toBe(false);
    expect(supportsHostProxy("chrome-extension", "host_file")).toBe(false);
    expect(supportsHostProxy("chrome-extension", "host_cu")).toBe(false);
  });

  test("capability form grants everything to macOS", () => {
    expect(supportsHostProxy("macos", "host_bash")).toBe(true);
    expect(supportsHostProxy("macos", "host_file")).toBe(true);
    expect(supportsHostProxy("macos", "host_cu")).toBe(true);
    expect(supportsHostProxy("macos", "host_browser")).toBe(true);
  });

  test("capability form rejects everything for non-host-proxy interfaces", () => {
    expect(supportsHostProxy("ios", "host_bash")).toBe(false);
    expect(supportsHostProxy("cli", "host_file")).toBe(false);
    expect(supportsHostProxy("telegram", "host_browser")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// supportsHostProxy — type predicate (compile-time contract)
// ---------------------------------------------------------------------------

describe("supportsHostProxy (type predicate)", () => {
  test("no-arg form narrows InterfaceId to HostProxyInterfaceId", () => {
    const id: InterfaceId = "macos";
    if (supportsHostProxy(id)) {
      // Inside this branch, TypeScript narrows `id` to HostProxyInterfaceId.
      // If the overload were wrong, this assignment would fail to type-check
      // and the test file wouldn't compile.
      const narrowed: HostProxyInterfaceId = id;
      expect(narrowed).toBe("macos");
    } else {
      throw new Error("expected narrowing branch to be taken for macos");
    }
  });

  test("narrowing reaches through discriminated transport union", () => {
    // Build a value typed as the full union so TypeScript can't cheat.
    const transport: ConversationTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    };

    if (transport.interfaceId && supportsHostProxy(transport.interfaceId)) {
      // Narrowing the discriminant narrows the union member — after this
      // check, `transport` should be HostProxyTransportMetadata and the
      // host-env fields are directly accessible.
      const narrowed: HostProxyTransportMetadata = transport;
      expect(narrowed.hostHomeDir).toBe("/Users/alice");
      expect(narrowed.hostUsername).toBe("alice");
    } else {
      throw new Error("expected host-proxy branch for macos transport");
    }
  });

  test("non-host-proxy branch narrows to NonHostProxyTransportMetadata", () => {
    const transport: ConversationTransportMetadata = {
      channelId: "vellum",
      interfaceId: "ios",
    };

    if (transport.interfaceId && supportsHostProxy(transport.interfaceId)) {
      throw new Error("expected non-host-proxy branch for ios transport");
    } else {
      // `transport` is NonHostProxyTransportMetadata here.
      const narrowed: NonHostProxyTransportMetadata = transport;
      expect(narrowed.interfaceId).toBe("ios");
    }
  });
});
