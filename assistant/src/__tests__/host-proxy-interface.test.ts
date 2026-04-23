import { describe, expect, test } from "bun:test";

import type { HostProxyInterfaceId, InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import type {
  ConversationTransportMetadata,
  HostProxyTransportMetadata,
  NonHostProxyTransportMetadata,
} from "../daemon/message-types/conversations.js";
import { isHostProxyTransport } from "../daemon/message-types/conversations.js";

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

  test("capability form grants all four capabilities to macOS including host_browser", () => {
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

// ---------------------------------------------------------------------------
// isHostProxyTransport — type guard on ConversationTransportMetadata
// ---------------------------------------------------------------------------

describe("isHostProxyTransport", () => {
  test("returns true for macOS transport and narrows to HostProxyTransportMetadata", () => {
    const transport: ConversationTransportMetadata = {
      channelId: "vellum",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    };

    expect(isHostProxyTransport(transport)).toBe(true);

    if (isHostProxyTransport(transport)) {
      const narrowed: HostProxyTransportMetadata = transport;
      expect(narrowed.hostHomeDir).toBe("/Users/alice");
      expect(narrowed.hostUsername).toBe("alice");
    } else {
      throw new Error("narrowing branch not taken");
    }
  });

  test("returns false for every non-host-proxy interface", () => {
    const nonHostProxyIds: Array<Exclude<InterfaceId, HostProxyInterfaceId>> = [
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
    for (const interfaceId of nonHostProxyIds) {
      const transport: ConversationTransportMetadata = {
        channelId: "vellum",
        interfaceId,
      };
      expect(isHostProxyTransport(transport)).toBe(false);
    }
  });

  test("returns false when interfaceId is absent", () => {
    const transport: ConversationTransportMetadata = {
      channelId: "vellum",
    };
    expect(isHostProxyTransport(transport)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// macOS host_browser capability — regression guards
// ---------------------------------------------------------------------------

describe("macOS host_browser capability", () => {
  test("macOS supports host_browser via supportsHostProxy capability check", () => {
    // macOS is now host-browser-capable, enabling host_browser_request
    // frames to be sent to the desktop client via SSE or extension registry.
    expect(supportsHostProxy("macos", "host_browser")).toBe(true);
  });

  test("macOS still passes the no-arg host-proxy check (full desktop proxy)", () => {
    // The no-arg form gates computer-use preactivation and full proxy restore.
    // macOS must still pass this check.
    expect(supportsHostProxy("macos")).toBe(true);
  });

  test("non-macOS non-extension interfaces remain host_browser-ineligible", () => {
    const ineligible: InterfaceId[] = [
      "ios",
      "cli",
      "telegram",
      "phone",
      "vellum",
      "whatsapp",
      "slack",
      "email",
    ];
    for (const id of ineligible) {
      expect(supportsHostProxy(id, "host_browser")).toBe(false);
    }
  });
});
