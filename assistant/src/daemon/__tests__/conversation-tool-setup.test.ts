/**
 * Tests for `isToolActiveForContext` host-tool capability gating.
 *
 * Scenarios verified:
 * - chrome-extension is its own executor and is exempt from the hasNoClient
 *   gate (the extension's own popup UI gates commands; there is no SSE
 *   interactive approval channel, and chrome-extension turns intentionally
 *   run with `hasNoClient: true` because chrome-extension is not in
 *   `INTERACTIVE_INTERFACES`).
 * - macos requires a connected SSE client for host tools that flow through
 *   the proxy (e.g. host_bash, host_file_*, host_browser), so
 *   `hasNoClient: true` denies those on macos.
 * - host_browser IS in the macos capability set — the proxy routes
 *   host_browser_request frames to the desktop client via SSE (or via the
 *   Chrome extension registry when an extension connection is present).
 *
 * The per-capability check (`supportsHostProxy(transport, capability)`) runs
 * first and is authoritative for structural support, so host_bash and
 * host_file_* are filtered out for chrome-extension regardless of the
 * hasNoClient flag.
 *
 * Cross-client exception (Phase 1): host_bash is allowed for non-host-proxy
 * interfaces (e.g. "web") when at least one host_bash-capable client is
 * connected via the event hub. host_file_* and host_browser remain filtered
 * regardless (Phase 2).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module-level mocks ─────────────────────────────────────────────

// Control how many host_bash-capable clients the hub reports.
let mockHostBashClientCount = 0;

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: (cap: string) => {
      if (cap === "host_bash") {
        return Array.from({ length: mockHostBashClientCount }, (_, i) => ({
          clientId: `mock-client-${i}`,
          capabilities: ["host_bash"],
        }));
      }
      return [];
    },
  },
  broadcastMessage: () => {},
}));

// Dynamic imports after mock.module calls so the stubs take effect
// before the modules under test are loaded.
const {
  HOST_TOOL_NAMES,
  HOST_TOOL_TO_CAPABILITY,
  isToolActiveForContext,
} = await import("../conversation-tool-setup.js");
type SkillProjectionContext =
  import("../conversation-tool-setup.js").SkillProjectionContext;
type SkillProjectionCache =
  import("../conversation-skill-tools.js").SkillProjectionCache;

function makeCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    coreToolNames: new Set<string>(),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockHostBashClientCount = 0;
});

describe("isToolActiveForContext — host tool capability gating", () => {
  // macOS transport: SSE-based interactive approval required.
  test("host_bash is active for macOS with a connected client", () => {
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_bash is NOT active for macOS when hasNoClient is true (security invariant)", () => {
    // macOS uses an SSE-based interactive approval channel. Without a
    // connected client the guardian auto-approve path could execute host
    // commands unattended, so host tools must be denied.
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(false);
  });

  test("host_file_read is NOT active for macOS when hasNoClient is true", () => {
    expect(
      isToolActiveForContext(
        "host_file_read",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(false);
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

  test("host_browser is NOT active for macOS when hasNoClient is true", () => {
    // macOS supports host_browser structurally, but without a connected
    // client the host_browser_request frames have no consumer, so the tool
    // is denied.
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(false);
  });

  // chrome-extension transport: the extension is its own executor.
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

  // Backwards-compat fallback: no transport plumbed through.
  test("host_bash falls back to hasNoClient gate when transport is undefined (client connected)", () => {
    // Without a transport interface we cannot run the per-capability check,
    // so we fall back to the coarse-grained `hasNoClient` behavior.
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: undefined }),
      ),
    ).toBe(true);
  });

  test("host_bash falls back to hasNoClient gate when transport is undefined (no client)", () => {
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: undefined }),
      ),
    ).toBe(false);
  });
});

describe("isToolActiveForContext — cross-client exception (Phase 1: host_bash)", () => {
  test("host_bash is active for web transport when a host_bash-capable client is connected", () => {
    // Cross-client path: a web turn should see host_bash when a macOS client
    // with host_bash capability is connected via the event hub.
    mockHostBashClientCount = 1;
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });

  test("host_bash is NOT active for web transport when no capable client is connected", () => {
    // No cross-client fallback: hub has no host_bash-capable subscribers.
    mockHostBashClientCount = 0;
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(false);
  });

  test("host_file_read is NOT active for web transport even when a capable client is connected (Phase 2 gate)", () => {
    // The cross-client exception is scoped to host_bash only.
    // host_file_* remain filtered for non-host-proxy interfaces regardless
    // of connected clients until Phase 2 lands.
    mockHostBashClientCount = 1;
    expect(
      isToolActiveForContext(
        "host_file_read",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(false);
  });

  test("host_bash for macos transport is unaffected by the cross-client exception", () => {
    // macos natively supports host_bash via host proxy — the supportsHostProxy
    // check passes, so the cross-client branch is never reached.
    mockHostBashClientCount = 0;
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_bash for macos with no client is still denied (security invariant unaffected)", () => {
    // Even with a capable client in the hub, the macos SSE path takes
    // precedence — it passes the supportsHostProxy check, bypasses the
    // cross-client branch, and reaches the hasNoClient gate.
    mockHostBashClientCount = 1;
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(false);
  });

  test("host_bash is NOT active for chrome-extension even when a capable client is connected", () => {
    // Security boundary: chrome-extension only gets host_browser. The
    // cross-client exception explicitly excludes chrome-extension transport
    // regardless of how many host_bash-capable clients are in the hub.
    mockHostBashClientCount = 1;
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "chrome-extension" }),
      ),
    ).toBe(false);
  });

  test("host_bash is NOT active for web transport when hasNoClient is true (no approval UI)", () => {
    // hasNoClient gate: no interactive approval UI available for this turn.
    // Cross-client exception must not bypass this gate.
    mockHostBashClientCount = 1;
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "web" }),
      ),
    ).toBe(false);
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
