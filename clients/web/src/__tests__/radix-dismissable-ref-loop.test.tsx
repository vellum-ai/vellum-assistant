/**
 * Guard for the Radix x React 19 "Maximum update depth exceeded" fix
 * (VELLUM-ASSISTANT-WEB-5C / -MACOS-1QW).
 *
 * Radix `DismissableLayer` (mounted by open Tooltip/Popover/Dropdown/Dialog
 * content) passed an unstable inline ref `(node) => setNode(node)` to
 * `useComposedRefs`. Under React 19's ref-cleanup semantics the ever-changing
 * ref identity makes React detach (ref(null) -> setNode(null)) and re-attach
 * (ref(node) -> setNode(node)) on every commit; while the subtree re-renders
 * rapidly (SSE streaming) that thrash blows past React's 50-update limit.
 *
 * Fix: `patches/@radix-ui%2Freact-dismissable-layer@1.1.13.patch` passes the
 * stable `setNode` setter directly so the composed ref identity is stable.
 *
 * The runtime loop is commit-phase/timing-sensitive and does NOT reproduce
 * under happy-dom (it needs a real browser; this repo otherwise tests Radix via
 * static markup). So rather than a flaky/non-discriminating runtime test, this
 * guard asserts the shipped dependency source actually carries the fix — it
 * fails loudly if a Radix version bump or a dropped `overrides`/patch entry
 * silently reverts us to the looping inline ref. Remove this guard (and the
 * patch) once upstream ships the fix in `@radix-ui/react-dismissable-layer`
 * (track: https://github.com/radix-ui/primitives/issues/3799).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The package `exports` map doesn't expose explicit `/dist/*` subpaths, so
// resolve the package root (allowed) and derive the dist dir from it.
const distDir = dirname(
  Bun.resolveSync("@radix-ui/react-dismissable-layer", import.meta.dir),
);

function readDismissableLayer(entry: "index.mjs" | "index.js"): string {
  return readFileSync(join(distDir, entry), "utf8");
}

describe("Radix DismissableLayer ref stabilization (React 19 fix)", () => {
  for (const entry of ["index.mjs", "index.js"] as const) {
    test(`${entry}: composed ref uses the stable setNode setter, not a per-render arrow`, () => {
      const src = readDismissableLayer(entry);
      // The looping pattern must be gone...
      expect(src).not.toContain("(node2) => setNode(node2)");
      // ...and replaced by the stable setter passed directly (the call is
      // formatted differently in the ESM vs CJS builds, so match the args).
      expect(src).toContain("(forwardedRef, setNode)");
    });
  }
});
