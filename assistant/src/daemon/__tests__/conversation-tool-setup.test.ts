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
 * Cross-client exception: tools whose capabilities are in
 * CROSS_CLIENT_EXPOSED_CAPABILITIES (host_bash, host_file, host_browser)
 * are allowed for non-host-proxy interactive interfaces ("web", "ios")
 * when at least one capable client is connected via the event hub.
 * chrome-extension is excluded as a security boundary, regardless of
 * whether the capability is technically supported elsewhere.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module-level mocks ─────────────────────────────────────────────

// Control how many capable clients the hub reports per capability.
const mockClientCountByCapability = new Map<string, number>();

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: (cap: string) => {
      const count = mockClientCountByCapability.get(cap) ?? 0;
      return Array.from({ length: count }, (_, i) => ({
        clientId: `mock-${cap}-client-${i}`,
        capabilities: [cap],
      }));
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
  mockClientCountByCapability.clear();
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
    mockClientCountByCapability.set("host_bash", 1);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(true);
  });

  test("host_bash is NOT active for web transport when no capable client is connected", () => {
    // No cross-client fallback: hub has no host_bash-capable subscribers.
    mockClientCountByCapability.set("host_bash", 0);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(false);
  });

  test("host_file_read is NOT active for web transport when only a host_bash client is connected", () => {
    // The cross-client exception is per-capability: a host_bash-capable
    // client in the hub does not satisfy host_file's exposure check, since
    // listClientsByCapability is queried with the tool's actual capability.
    mockClientCountByCapability.set("host_bash", 1);
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
    mockClientCountByCapability.set("host_bash", 0);
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
    mockClientCountByCapability.set("host_bash", 1);
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
    mockClientCountByCapability.set("host_bash", 1);
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
    mockClientCountByCapability.set("host_bash", 1);
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "web" }),
      ),
    ).toBe(false);
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

    test(`${tool} is NOT exposed for web when no host_file client is connected`, () => {
      mockClientCountByCapability.set("host_file", 0);
      expect(
        isToolActiveForContext(
          tool,
          makeCtx({ hasNoClient: false, transportInterface: "web" }),
        ),
      ).toBe(false);
    });

    test(`${tool} is NOT exposed for chrome-extension (security boundary)`, () => {
      mockClientCountByCapability.set("host_file", 1);
      expect(
        isToolActiveForContext(
          tool,
          makeCtx({ hasNoClient: true, transportInterface: "chrome-extension" }),
        ),
      ).toBe(false);
    });

    test(`${tool} is NOT exposed when hasNoClient is true (no approval UI)`, () => {
      mockClientCountByCapability.set("host_file", 1);
      expect(
        isToolActiveForContext(
          tool,
          makeCtx({ hasNoClient: true, transportInterface: "web" }),
        ),
      ).toBe(false);
    });
  }

  test("listClientsByCapability is queried with the actual capability, not host_bash (regression guard for D5 latent bug)", () => {
    mockClientCountByCapability.set("host_bash", 0);
    mockClientCountByCapability.set("host_file", 1);
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

  test("host_browser is NOT exposed for web when no host_browser client is connected", () => {
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
      ),
    ).toBe(false);
  });

  test("host_browser is NOT exposed for ios when no host_browser client is connected", () => {
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "ios" }),
      ),
    ).toBe(false);
  });

  test("host_browser is NOT exposed when hasNoClient is true (no approval UI)", () => {
    // hasNoClient gate: cross-client exception must not bypass this.
    mockClientCountByCapability.set("host_browser", 1);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: true, transportInterface: "web" }),
      ),
    ).toBe(false);
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

  test("listClientsByCapability is queried with host_browser, not host_bash or host_file (per-capability invariant)", () => {
    // Defense against any future regression that hardcodes a different
    // capability in the cross-client check. Only host_browser-capable
    // clients should satisfy host_browser exposure.
    mockClientCountByCapability.set("host_bash", 1);
    mockClientCountByCapability.set("host_file", 1);
    mockClientCountByCapability.set("host_browser", 0);
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "web" }),
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
