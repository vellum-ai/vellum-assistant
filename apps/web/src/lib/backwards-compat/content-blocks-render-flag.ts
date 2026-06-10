// Dev flag: render the chat transcript exclusively from each message's
// unified `contentBlocks` projection instead of the legacy positional
// arrays (`textSegments` / `thinkingSegments` / `toolCalls` / `surfaces`
// walked via `contentOrder`).
//
// Lives alongside `impersonate-version-flag`, `pickConversationIdWireField`,
// `useAssistantSupports`, etc. so the toggle sits next to the other
// dev-only switches that select between two client behaviours.
//
// Purpose: `contentBlocks` is being promoted to the authoritative content
// slice. During QA we want an apples-to-apples switch between the two
// render paths — the new blocks-driven walk vs. the legacy positional
// walk — as the *single* source of truth, rather than a per-read
// `block ?? positional` fallback that never exercises blocks at 100%.
// The render path reads `getRenderFromContentBlocks()` to pick its body.
//
// Mechanism: `renderFromContentBlocks(true|false)` writes to localStorage
// and reloads. The render path resolves the flag once per message body, so
// a reload guarantees the whole transcript re-renders from one consistent
// source instead of mixing two walks across rows mounted before/after the
// flip. Same reload rationale as `impersonateVersion`.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   renderFromContentBlocks(true)   — enable blocks-driven render + reload
//   renderFromContentBlocks(false)  — restore legacy positional render + reload
//   renderFromContentBlocks()       — log + return current value, no reload

import { getLocalBool, setLocalBool } from "@/utils/local-settings";

const STORAGE_KEY = "vellum:debug:renderFromContentBlocks";

/**
 * Read the flag synchronously. Safe to call at any time, including from
 * inside the render path (the primary consumer). Defaults to `false`
 * (legacy positional render) when unset or when localStorage access
 * throws (private browsing / sandboxed iframes).
 */
export function getRenderFromContentBlocks(): boolean {
  return getLocalBool(STORAGE_KEY, false);
}

/**
 * Set or inspect the content-blocks render flag.
 *
 * - `value: boolean` — persist and reload so the transcript re-renders
 *   from the chosen source uniformly.
 * - `value: undefined` — inspect-only. Log + return the current value.
 *   No mutation, no reload.
 *
 * Returns the value in effect after the call (post-reload for a set,
 * current for inspect). The reload kills the JS context, so callers
 * rarely consume the return value on the set path — it's documented
 * mainly for tests.
 */
export function setRenderFromContentBlocks(value?: boolean): boolean {
  if (typeof window === "undefined") return false;

  // Inspect-only branch — explicitly no-op, no reload.
  if (value === undefined) {
    const current = getRenderFromContentBlocks();
    console.info(
      `[vellumDebug] renderFromContentBlocks (current) = ${String(current)}`,
    );
    return current;
  }

  setLocalBool(STORAGE_KEY, value);
  if (getRenderFromContentBlocks() !== value) {
    console.warn(
      "[vellumDebug] failed to persist renderFromContentBlocks flag",
    );
    return getRenderFromContentBlocks();
  }
  console.info(
    `[vellumDebug] renderFromContentBlocks = ${String(value)} — reloading…`,
  );
  window.location.reload();
  return value;
}
