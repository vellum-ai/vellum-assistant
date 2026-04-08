/**
 * Tests for `isToolActiveForContext` host-tool capability gating.
 *
 * Two scenarios are verified:
 * - chrome-extension is its own executor and is exempt from the hasNoClient
 *   gate (the extension's own popup UI gates commands; there is no SSE
 *   interactive approval channel, and chrome-extension turns intentionally
 *   run with `hasNoClient: true` because chrome-extension is not in
 *   `INTERACTIVE_INTERFACES`).
 * - macos still requires a connected SSE client for interactive approval, so
 *   `hasNoClient: true` continues to deny all host tools on macos.
 *
 * The per-capability check (`supportsHostProxy(transport, capability)`) runs
 * first and is authoritative for structural support, so host_bash and
 * host_file_* are filtered out for chrome-extension regardless of the
 * hasNoClient flag.
 */

import { describe, expect, test } from "bun:test";

import type { SkillProjectionCache } from "../conversation-skill-tools.js";
import {
  HOST_TOOL_NAMES,
  HOST_TOOL_TO_CAPABILITY,
  isToolActiveForContext,
  type SkillProjectionContext,
} from "../conversation-tool-setup.js";

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
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_browser is NOT active for macOS when hasNoClient is true", () => {
    // macOS requires a client for any host tool — the SSE interactive
    // approval channel must be available regardless of capability.
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
