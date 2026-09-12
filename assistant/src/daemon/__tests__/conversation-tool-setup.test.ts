/**
 * Tests for host-tool schema visibility. Host tool definitions stay stable
 * across interactive and background turns. Chrome extension remains limited
 * to host_browser because it is the only host capability it implements.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../conversation.js";
import type { ChannelCapabilities } from "../conversation-runtime-assembly.js";

// ── Module-level mocks ─────────────────────────────────────────────

// Control how many capable clients the hub reports per capability.
const mockClientCountByCapability = new Map<string, number>();
const mockClientsByCapability = new Map<
  string,
  Array<{
    clientId: string;
    capabilities: string[];
    interfaceId: string;
    actorPrincipalId?: string;
  }>
>();

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: (cap: string) => {
      const clients = mockClientsByCapability.get(cap);
      if (clients) {
        return clients;
      }
      const count = mockClientCountByCapability.get(cap) ?? 0;
      return Array.from({ length: count }, (_, i) => ({
        clientId: `mock-${cap}-client-${i}`,
        capabilities: [cap],
        interfaceId: "macos",
      }));
    },
  },
  broadcastMessage: () => {},
}));

// Dynamic imports after mock.module calls so the stubs take effect
// before the modules under test are loaded.
const {
  ALLOWLIST_ONLY_TOOL_NAMES,
  HOST_TOOL_NAMES,
  HOST_TOOL_TO_CAPABILITY,
  isToolActiveForContext,
} = await import("../conversation-tool-setup.js");
const { registerSkillTools, unregisterSkillTools } =
  await import("../../tools/registry.js");
const { finalizeTool } = await import("../../tools/tool-defaults.js");
type SkillProjectionCache =
  import("../conversation-skill-tools.js").SkillProjectionCache;

function makeCtx(
  overrides: Partial<Omit<Conversation, "channelCapabilities">> & {
    channelCapabilities?: Partial<ChannelCapabilities>;
  } = {},
): Conversation {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    toolsDisabledDepth: 0,
    ...overrides,
  } as unknown as Conversation;
}

beforeEach(() => {
  mockClientCountByCapability.clear();
  mockClientsByCapability.clear();
});

describe("isToolActiveForContext - client OS eligibility", () => {
  test("hides a macOS-only skill tool from Windows turns", () => {
    const skillId = "client-os-test-skill";
    registerSkillTools(skillId, [
      finalizeTool({
        name: "client_os_test_tool",
        supportedClientOs: ["macos"],
      }),
    ]);

    try {
      expect(
        isToolActiveForContext(
          "client_os_test_tool",
          makeCtx({
            clientOs: "windows",
            currentTurnClientOs: "windows",
          }),
        ),
      ).toBe(false);
      expect(
        isToolActiveForContext(
          "client_os_test_tool",
          makeCtx({ clientOs: "macos", currentTurnClientOs: "macos" }),
        ),
      ).toBe(true);
    } finally {
      unregisterSkillTools(skillId);
    }
  });

  test("uses same-user target desktops for cross-client tool eligibility", () => {
    const skillId = "cross-client-os-test-skill";
    registerSkillTools(skillId, [
      finalizeTool({
        name: "computer_use_platform_test",
        supportedClientOs: ["macos"],
      }),
    ]);
    const ctx = makeCtx({
      clientOs: "web",
      currentTurnClientOs: "web",
      transportInterface: "web",
      getTurnActorPrincipalId: () => "actor-1",
    });

    try {
      mockClientsByCapability.set("host_cu", [
        {
          clientId: "mac-client",
          capabilities: ["host_cu"],
          interfaceId: "macos",
          actorPrincipalId: "actor-1",
        },
      ]);
      expect(isToolActiveForContext("computer_use_platform_test", ctx)).toBe(
        true,
      );

      mockClientsByCapability.set("host_cu", [
        {
          clientId: "windows-client",
          capabilities: ["host_cu"],
          interfaceId: "windows",
          actorPrincipalId: "actor-1",
        },
      ]);
      expect(isToolActiveForContext("computer_use_platform_test", ctx)).toBe(
        false,
      );
    } finally {
      unregisterSkillTools(skillId);
    }
  });

  test("falls back to linux client OS from the linux transport interface", () => {
    const skillId = "linux-transport-client-os-test-skill";
    registerSkillTools(skillId, [
      finalizeTool({
        name: "linux_transport_os_test_tool",
        supportedClientOs: ["linux"],
      }),
    ]);

    try {
      expect(
        isToolActiveForContext(
          "linux_transport_os_test_tool",
          makeCtx({
            transportInterface: "linux",
          }),
        ),
      ).toBe(true);
      expect(
        isToolActiveForContext(
          "linux_transport_os_test_tool",
          makeCtx({
            transportInterface: "windows",
          }),
        ),
      ).toBe(false);
    } finally {
      unregisterSkillTools(skillId);
    }
  });

  test("uses pinned client OS without falling through to live context", () => {
    const skillId = "pinned-client-os-test-skill";
    registerSkillTools(skillId, [
      finalizeTool({
        name: "client_os_pinned_test_tool",
        supportedClientOs: ["macos"],
      }),
    ]);

    try {
      expect(
        isToolActiveForContext(
          "client_os_pinned_test_tool",
          makeCtx({
            clientOs: "windows",
            currentTurnClientOs: "windows",
            toolContextPin: {
              hasNoClient: false,
              transportInterface: "macos",
              clientOs: "macos",
            },
          }),
        ),
      ).toBe(true);
      expect(
        isToolActiveForContext(
          "client_os_pinned_test_tool",
          makeCtx({
            clientOs: "macos",
            currentTurnClientOs: "macos",
            toolContextPin: {
              hasNoClient: false,
              transportInterface: "windows",
              clientOs: "windows",
            },
          }),
        ),
      ).toBe(false);
    } finally {
      unregisterSkillTools(skillId);
    }
  });
});

describe("isToolActiveForContext - Slack task_progress UI exception", () => {
  test("ui_show and ui_update are active for Slack task_progress turns", () => {
    const ctx = makeCtx({
      hasNoClient: false,
      channelCapabilities: {
        channel: "slack",
        supportsDynamicUi: false,
      },
    });

    expect(isToolActiveForContext("ui_show", ctx)).toBe(true);
    expect(isToolActiveForContext("ui_update", ctx)).toBe(true);
  });

  test("ui_dismiss stays active for Slack without dynamic UI support", () => {
    expect(
      isToolActiveForContext(
        "ui_dismiss",
        makeCtx({
          hasNoClient: false,
          channelCapabilities: {
            channel: "slack",
            supportsDynamicUi: false,
          },
        }),
      ),
    ).toBe(true);
  });

  test("Slack UI tools stay active for a clientless turn", () => {
    for (const name of ["ui_show", "ui_update", "ui_dismiss"]) {
      expect(
        isToolActiveForContext(
          name,
          makeCtx({
            hasNoClient: true,
            channelCapabilities: {
              channel: "slack",
              supportsDynamicUi: false,
            },
          }),
        ),
      ).toBe(true);
    }
  });

  test("other non-dynamic channels keep UI surface tools on the wire", () => {
    for (const name of ["ui_show", "ui_update", "ui_dismiss"]) {
      expect(
        isToolActiveForContext(
          name,
          makeCtx({
            hasNoClient: false,
            channelCapabilities: {
              channel: "telegram",
              supportsDynamicUi: false,
            },
          }),
        ),
      ).toBe(true);
    }
  });
});

describe("isToolActiveForContext — host tool capability gating", () => {
  test("host_bash is active for macOS with a connected client", () => {
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_bash remains active for a background macOS turn", () => {
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });
  test("host_file_read remains active for a background macOS turn", () => {
    expect(
      isToolActiveForContext(
        "host_file_read",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });
  test("host_browser is active for macOS with a connected client", () => {
    // macOS supports host_browser — the proxy routes host_browser_request
    // frames to the desktop client via SSE (or via the Chrome extension
    // registry when an extension connection is present).
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_browser remains active for a background macOS turn", () => {
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });
  test("host_browser is active for chrome-extension even when hasNoClient is true", () => {
    // chrome-extension turns run with `hasNoClient: true` by design because
    // chrome-extension is not in `INTERACTIVE_INTERFACES` — it is not an
    // SSE interactive channel. The extension gates host_browser commands
    // via its own popup UI, so the hasNoClient gate must not filter
    // host_browser out for chrome-extension transports.
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({
          hasNoClient: true,
          transportInterface: "chrome-extension",
        }),
      ),
    ).toBe(true);
  });

  test("host_browser is active for chrome-extension when hasNoClient is false", () => {
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({
          hasNoClient: false,
          transportInterface: "chrome-extension",
        }),
      ),
    ).toBe(true);
  });

  test("host_bash is NOT active for chrome-extension even when hasNoClient is true", () => {
    // The per-capability check runs first and is authoritative: chrome-extension
    // only supports `host_browser`, so `host_bash` must be filtered out.
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({
          hasNoClient: true,
          transportInterface: "chrome-extension",
        }),
      ),
    ).toBe(false);
  });

  test("host_file_read is NOT active for chrome-extension when hasNoClient is true", () => {
    expect(
      isToolActiveForContext(
        "host_file_read",
        makeCtx({
          hasNoClient: true,
          transportInterface: "chrome-extension",
        }),
      ),
    ).toBe(false);
  });

  test("host_bash remains active without transport metadata for a connected turn", () => {
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: undefined }),
      ),
    ).toBe(true);
  });

  test("host_bash remains active without transport metadata for a background turn", () => {
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: undefined }),
      ),
    ).toBe(true);
  });
});

describe("isToolActiveForContext — cross-client exception (Phase 1: host_bash)", () => {
  test("host_bash is active for web transport when a host_bash-capable client is connected", () => {
    mockClientCountByCapability.set("host_bash", 1);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });

  test("host_bash remains active for web when no capable client is connected", () => {
    mockClientCountByCapability.set("host_bash", 0);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });
  test("host_file_read remains active for web without host_file clients", () => {
    mockClientCountByCapability.set("host_bash", 1);
    expect(
      isToolActiveForContext(
        "host_file_read",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });
  test("host_bash for macos transport is unaffected by the cross-client exception", () => {
    // macos natively supports host_bash via host proxy — the supportsHostProxy
    // check passes, so the cross-client branch is never reached.
    mockClientCountByCapability.set("host_bash", 0);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_bash remains active for a background macOS turn", () => {
    mockClientCountByCapability.set("host_bash", 1);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });
  test("host_bash is NOT active for chrome-extension even when a capable client is connected", () => {
    // Security boundary: chrome-extension only gets host_browser. The
    // cross-client exception explicitly excludes chrome-extension transport
    // regardless of how many host_bash-capable clients are in the hub.
    mockClientCountByCapability.set("host_bash", 1);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "chrome-extension" }),
      ),
    ).toBe(false);
  });

  test("host_bash remains active for a background web turn", () => {
    mockClientCountByCapability.set("host_bash", 1);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "web" }),
      ),
    ).toBe(true);
  });
});

describe("isToolActiveForContext — cross-client exposure for host_file_*", () => {
  const HOST_FILE_TOOLS = [
    "host_file_read",
    "host_file_write",
    "host_file_edit",
    "host_file_transfer",
  ] as const;

  for (const tool of HOST_FILE_TOOLS) {
    test(`${tool} is exposed for web transport when a host_file client is connected`, () => {
      mockClientCountByCapability.set("host_file", 1);
      expect(
        isToolActiveForContext(
          tool,
          makeCtx({ hasNoClient: false, transportInterface: "web" }),
        ),
      ).toBe(true);
    });

    test(`${tool} remains active for web when no host_file client is connected`, () => {
      mockClientCountByCapability.set("host_file", 0);
      expect(
        isToolActiveForContext(
          tool,
          makeCtx({ hasNoClient: false, transportInterface: "web" }),
        ),
      ).toBe(true);
    });

    test(`${tool} is NOT exposed for chrome-extension (security boundary)`, () => {
      mockClientCountByCapability.set("host_file", 1);
      expect(
        isToolActiveForContext(
          tool,
          makeCtx({
            hasNoClient: true,
            transportInterface: "chrome-extension",
          }),
        ),
      ).toBe(false);
    });

    test(`${tool} remains active for a background web turn`, () => {
      mockClientCountByCapability.set("host_file", 1);
      expect(
        isToolActiveForContext(
          tool,
          makeCtx({ hasNoClient: true, transportInterface: "web" }),
        ),
      ).toBe(true);
    });
  }

  test("host_file_transfer does not depend on the live host_file roster", () => {
    mockClientCountByCapability.set("host_file", 0);
    expect(
      isToolActiveForContext(
        "host_file_transfer",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });
});

describe("isToolActiveForContext — cross-client exposure for host_browser", () => {
  // host_browser cross-client routing was shipped in PR #27489 (host-
  // browser-via-macos-host-proxy); LLM-exposure for non-host-proxy
  // transports is added by including "host_browser" in
  // CROSS_CLIENT_EXPOSED_CAPABILITIES. Web and iOS turns can now drive a
  // connected macOS or chrome-extension client via the event hub.
  test("host_browser is exposed for web transport when a host_browser client is connected", () => {
    mockClientCountByCapability.set("host_browser", 1);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });

  test("host_browser is exposed for ios transport when a host_browser client is connected", () => {
    // INTERACTIVE_INTERFACES = {macos, ios, web}; ios goes through the same
    // cross-client branch as web because supportsHostProxy("ios", *) is
    // false. This pins the parity guarantee.
    mockClientCountByCapability.set("host_browser", 1);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "ios" }),
      ),
    ).toBe(true);
  });

  test("host_browser remains active for web when no host_browser client is connected", () => {
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });
  test("host_browser remains active for ios when no host_browser client is connected", () => {
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "ios" }),
      ),
    ).toBe(true);
  });
  test("host_browser remains active for a background web turn", () => {
    mockClientCountByCapability.set("host_browser", 1);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: true, transportInterface: "web" }),
      ),
    ).toBe(true);
  });
  test("host_browser for macos transport is unaffected by the cross-client exception", () => {
    // macos natively supports host_browser via host proxy — the
    // supportsHostProxy check passes, so the cross-client branch is never
    // reached.
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_browser for chrome-extension transport is unaffected by the cross-client exception", () => {
    // chrome-extension natively supports host_browser via its own
    // executor (supportsHostProxy("chrome-extension", "host_browser")
    // returns true), so the cross-client branch is never reached. The
    // hasNoClient gate is also bypassed for chrome-extension transports
    // because the extension provides its own approval UI.
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: true, transportInterface: "chrome-extension" }),
      ),
    ).toBe(true);
  });

  test("host_browser does not depend on the live host_browser roster", () => {
    mockClientCountByCapability.set("host_bash", 1);
    mockClientCountByCapability.set("host_file", 1);
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });
});

describe("isToolActiveForContext — ask_question macOS gating", () => {
  test("ask_question is active for web client with a connected client", () => {
    expect(
      isToolActiveForContext(
        "ask_question",
        makeCtx({
          hasNoClient: false,
          channelCapabilities: {
            channel: "web",
            supportsDynamicUi: true,
            clientOS: "web",
          },
        }),
      ),
    ).toBe(true);
  });

  test("ask_question is NOT active when clientOS is macos", () => {
    // The macOS client has no UI handler for question_request yet; the tool
    // is hidden to avoid a 5-minute prompter timeout.
    expect(
      isToolActiveForContext(
        "ask_question",
        makeCtx({
          hasNoClient: false,
          channelCapabilities: {
            channel: "macos",
            supportsDynamicUi: true,
            clientOS: "macos",
          },
        }),
      ),
    ).toBe(false);
  });

  test("ask_question is active when channelCapabilities is undefined (backwards-compat)", () => {
    expect(
      isToolActiveForContext("ask_question", makeCtx({ hasNoClient: false })),
    ).toBe(true);
  });

  test("ask_question is NOT active when hasNoClient is true regardless of clientOS", () => {
    expect(
      isToolActiveForContext(
        "ask_question",
        makeCtx({
          hasNoClient: true,
          channelCapabilities: {
            channel: "web",
            supportsDynamicUi: true,
            clientOS: "web",
          },
        }),
      ),
    ).toBe(false);
  });

  test("app_open is skill-owned and not client-capability gated", () => {
    // The app-builder skill provides app_open; its executor degrades
    // gracefully when no client is connected, so the context filter does
    // not hide it even on clientless turns.
    expect(
      isToolActiveForContext("app_open", makeCtx({ hasNoClient: true })),
    ).toBe(true);
  });
});

describe("HOST_TOOL_NAMES derivation", () => {
  test("HOST_TOOL_NAMES is derived from HOST_TOOL_TO_CAPABILITY", () => {
    // Sanity check: every tool in the names set has a capability mapping.
    // This is structurally enforced by the code (HOST_TOOL_NAMES is built
    // from HOST_TOOL_TO_CAPABILITY.keys()), but we test it to make the
    // invariant visible to readers and to catch any regression that
    // splits the two collections back apart.
    for (const name of HOST_TOOL_NAMES) {
      expect(HOST_TOOL_TO_CAPABILITY.has(name)).toBe(true);
    }
    // Cardinality check: the two collections must have the same size so a
    // future addition to HOST_TOOL_NAMES without a matching capability entry
    // (or vice versa) would fail.
    expect(HOST_TOOL_NAMES.size).toBe(HOST_TOOL_TO_CAPABILITY.size);
  });
});

describe("isToolActiveForContext — allowlist-only tools (delete_memory_page)", () => {
  test("delete_memory_page is a registered allowlist-only tool", () => {
    // Guards the wiring: the constant memory consolidation depends on must
    // actually contain the tool, or the gate below would silently hide it
    // from the consolidation run too.
    expect(ALLOWLIST_ONLY_TOOL_NAMES.has("delete_memory_page")).toBe(true);
  });

  test("hidden from a normal turn that carries no subagent allowlist", () => {
    // No user-facing or injected-content turn should ever be handed a delete
    // primitive: with no allowlist the tool stays off the wire.
    expect(isToolActiveForContext("delete_memory_page", makeCtx())).toBe(false);
  });

  test("visible to a wire-scoped run that allowlists it (memory consolidation)", () => {
    expect(
      isToolActiveForContext(
        "delete_memory_page",
        makeCtx({
          subagentAllowedTools: new Set([
            "file_read",
            "file_write",
            "delete_memory_page",
          ]),
        }),
      ),
    ).toBe(true);
  });

  test("hidden from a wire-scoped run whose allowlist omits it", () => {
    expect(
      isToolActiveForContext(
        "delete_memory_page",
        makeCtx({ subagentAllowedTools: new Set(["file_read", "recall"]) }),
      ),
    ).toBe(false);
  });

  test("stays hidden in execution gate mode unless the allowlist names it", () => {
    // Execution-gate runs keep the full wire surface (the allowlist is enforced
    // at execution time), so the ALLOWLIST_ONLY gate is what keeps the tool off
    // the wire for a run that did not opt in.
    expect(
      isToolActiveForContext(
        "delete_memory_page",
        makeCtx({
          subagentToolGateMode: "execution",
          subagentAllowedTools: new Set(["remember"]),
        }),
      ),
    ).toBe(false);
  });
});
