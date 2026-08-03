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
 *   window._vellumDebug.apps.disableIframeSandbox = true
 *
 * Only the literal `true` enables it. The value lives in memory (a page
 * reload restores the sandbox) and flipping it logs a console warning
 * that stays in the transcript for the rest of the session.
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

const ROOT_NS = "_vellumDebug";
const APPS_NS = "apps";
const FLAG_KEY = "disableIframeSandbox";

let sandboxDisabled = false;
const listeners = new Set<() => void>();

/** Whether app iframes currently render without a `sandbox` attribute. */
export function isAppIframeSandboxDisabled(): boolean {
  return sandboxDisabled;
}

function setAppIframeSandboxDisabled(value: unknown): void {
  const next = value === true;
  if (next === sandboxDisabled) {
    return;
  }
  sandboxDisabled = next;
  if (next) {
    console.warn(
      `[vellumDebug] ${APPS_NS}.${FLAG_KEY} = true: app iframes render without ` +
        "the sandbox attribute. App HTML runs same-origin with the host and can " +
        "reach its DOM, storage, and cookies. Open apps reload to pick this up. " +
        "Set it back to false, or reload the page, to restore the sandbox.",
    );
  } else {
    console.info(
      `[vellumDebug] ${APPS_NS}.${FLAG_KEY} = false: app iframes are sandboxed again.`,
    );
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * Subscribe a component to the flag. Returns `false` until someone sets
 * `window._vellumDebug.apps.disableIframeSandbox = true`, and re-renders
 * the caller on every change.
 */
export function useAppIframeSandboxDisabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    isAppIframeSandboxDisabled,
    () => false,
  );
}

/**
 * Attach the `apps` namespace to `window._vellumDebug`, siblings of the
 * `chat` and `events` namespaces installed from the chat page.
 *
 * The flag is an accessor rather than a plain property so a console
 * assignment is observable: the setter is what warns and notifies
 * mounted viewers. Called once at boot so the namespace is there before
 * an app is open, and safe to call again (the property is
 * `configurable`). No-op on the server.
 */
export function installAppSandboxDebugFlag(): void {
  if (typeof window === "undefined") {
    return;
  }
  const win = window as Omit<Window, typeof ROOT_NS> & {
    [ROOT_NS]?: Record<string, unknown>;
  };
  const root = win[ROOT_NS] ?? {};
  const apps = (root[APPS_NS] as Record<string, unknown> | undefined) ?? {};
  Object.defineProperty(apps, FLAG_KEY, {
    configurable: true,
    enumerable: true,
    get: isAppIframeSandboxDisabled,
    set: setAppIframeSandboxDisabled,
  });
  root[APPS_NS] = apps;
  win[ROOT_NS] = root;
}
