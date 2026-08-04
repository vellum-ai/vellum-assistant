/**
 * Opt-in debug flag that drops the `sandbox` attribute from app iframes.
 *
 * Apps render as `srcdoc` inside `sandbox="allow-scripts"` (no
 * `allow-same-origin`), so the app document gets an opaque origin. Every
 * API gated on a real security origin fails there: `getDisplayMedia()`
 * rejects with `SecurityError: Invalid security origin`. Dropping
 * `sandbox` gives the frame the host's origin, which is what those APIs
 * need, at the cost of the isolation the sandbox buys: the app document
 * runs same-origin with the host and can reach its DOM, storage, and
 * cookies.
 *
 * That trade is why the flag is off unless a developer types it, in
 * DevTools, on the session they want it:
 *
 *   window._vellumDebug.flags.toggleAppsSandboxDisabled()
 *
 * The value lives in memory (a page reload restores the sandbox) and
 * flipping it logs a console warning that stays in the transcript for
 * the rest of the session.
 *
 * This module owns the flag's state and semantics. The console binding
 * lives with the other flags in the `_vellumDebug.flags` namespace,
 * installed by {@link @/domains/chat/utils/debug-api}.
 *
 * The flag ships in production builds. It exists to demo screen-capture
 * apps against platform-hosted assistants, which run production
 * bundles, so it must not be compiled out.
 *
 * @see {@link @/components/app-viewer-container} for the consumer, which
 *   re-keys the iframe on every change so the frame reloads under the
 *   attribute in effect.
 */

import { useSyncExternalStore } from "react";

const FLAG_LABEL = "flags.toggleAppsSandboxDisabled";

let sandboxDisabled = false;
const listeners = new Set<() => void>();

/** Whether app iframes currently render without a `sandbox` attribute. */
export function isAppIframeSandboxDisabled(): boolean {
  return sandboxDisabled;
}

/**
 * Flip the flag, or set it explicitly.
 *
 *  - `toggleAppsSandboxDisabled()`      : flip the current value.
 *  - `toggleAppsSandboxDisabled(true)`  : drop the sandbox.
 *  - `toggleAppsSandboxDisabled(false)` : restore it.
 *
 * Returns the value in effect after the call. Logs on every change and
 * notifies mounted viewers, which re-key their iframe so the document
 * reloads under the attribute now in effect.
 */
export function toggleAppIframeSandboxDisabled(value?: boolean): boolean {
  const next = value === undefined ? !sandboxDisabled : value === true;
  if (next === sandboxDisabled) {
    console.info(`[vellumDebug] ${FLAG_LABEL}: already ${String(next)}.`);
    return sandboxDisabled;
  }
  sandboxDisabled = next;
  if (next) {
    console.warn(
      `[vellumDebug] ${FLAG_LABEL} = true: app iframes render without ` +
        "the sandbox attribute. App HTML runs same-origin with the host and can " +
        "reach its DOM, storage, and cookies. Open apps reload to pick this up. " +
        "Call it again, or reload the page, to restore the sandbox.",
    );
  } else {
    console.info(
      `[vellumDebug] ${FLAG_LABEL} = false: app iframes are sandboxed again.`,
    );
  }
  for (const listener of listeners) {
    listener();
  }
  return sandboxDisabled;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * Subscribe a component to the flag. Returns `false` until someone calls
 * `window._vellumDebug.flags.toggleAppsSandboxDisabled()`, and re-renders
 * the caller on every change.
 */
export function useAppIframeSandboxDisabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    isAppIframeSandboxDisabled,
    () => false,
  );
}
