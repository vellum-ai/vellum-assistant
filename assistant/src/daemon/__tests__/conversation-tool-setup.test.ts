/**
 * Tests for `isToolActiveForContext` host-tool capability gating.
 *
 * The chrome-extension interface only supports the `host_browser` host proxy
 * capability, so host tools must be gated by
 * `supportsHostProxy(transport, capability)` instead of a single
 * `hasNoClient` check. These tests assert that:
 *
 * - Each host tool is only projected for transports whose interface supports
 *   the matching capability (e.g. `host_bash` is only active for macOS, not
 *   chrome-extension — regression coverage for the Codex P1 host-tool leak).
 * - The `hasNoClient` precondition still takes precedence so HTTP-only paths
 *   never see host tools.
 * - Contexts without a `transportInterface` fall back to the permissive
 *   coarse-grained behavior so callers that have not yet plumbed the field
 *   through `SkillProjectionContext` continue to see the host tools their
 *   `hasNoClient` state allows.
 */

import { describe, expect, test } from "bun:test";

import type { SkillProjectionCache } from "../conversation-skill-tools.js";
import {
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
  test("host_bash is active for macOS transport (full host proxy support)", () => {
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_bash is NOT active for chrome-extension transport (Codex P1 regression)", () => {
    // Regression coverage: chrome-extension only supports `host_browser`, so
    // `host_bash` must NOT be projected even though a client is connected
    // (`hasNoClient: false`). Without per-capability gating the model could
    // attempt host_bash calls that the transport cannot dispatch.
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({
          hasNoClient: false,
          transportInterface: "chrome-extension",
        }),
      ),
    ).toBe(false);
  });

  test("host_browser is active for chrome-extension transport", () => {
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

  test("host_browser is active for macOS transport", () => {
    expect(
      isToolActiveForContext(
        "host_browser",
        makeCtx({ hasNoClient: false, transportInterface: "macos" }),
      ),
    ).toBe(true);
  });

  test("host_file_read is NOT active for chrome-extension transport", () => {
    expect(
      isToolActiveForContext(
        "host_file_read",
        makeCtx({
          hasNoClient: false,
          transportInterface: "chrome-extension",
        }),
      ),
    ).toBe(false);
  });

  test("host_bash respects hasNoClient even when transport supports it", () => {
    // The existing `hasNoClient` gate must continue to take precedence: even
    // a macOS-capable transport must not surface host tools when no client is
    // actually connected (e.g. the HTTP-only path).
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: true, transportInterface: "macos" }),
      ),
    ).toBe(false);
  });

  test("host_bash falls back to permissive behavior when transport is undefined", () => {
    // Backwards-compat fallback: contexts that don't pass a transport
    // interface (e.g. tests, callers that haven't plumbed the new field)
    // keep the coarse-grained behavior so we don't accidentally hide tools.
    expect(
      isToolActiveForContext(
        "host_bash",
        makeCtx({ hasNoClient: false, transportInterface: undefined }),
      ),
    ).toBe(true);
  });
});
