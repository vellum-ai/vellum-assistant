/**
 * The `window._vellumDebug.flags` namespace — every dev-toggleable client
 * flag, in one place, installed once at boot from `main.tsx`.
 *
 * Boot-time install is the point of the namespace. The other halves of
 * `_vellumDebug` (`chat`, `events`, `api`) are built from React refs the
 * chat page owns, so they are installed on that page's mount and deleted
 * on its unmount. Flags are pure module state with no page affinity, and
 * the surfaces they gate are not chat-only — app iframes render from the
 * library detail page as well as chat. Installing them here keeps every
 * flag reachable from the console on every route, whatever has mounted.
 *
 * Two shapes live side by side, matched to what each flag has to do:
 *
 *   - **Functions** for flags that persist and need the page rebuilt
 *     around them. `impersonateVersion` writes to localStorage and
 *     reloads, because version-derived constants are cached at module
 *     load and a live flip would leave half the app on the old value.
 *
 *   - **Accessors** for flags that take effect in place.
 *     `disableIframeSandbox` is in-memory only (a reload restores the
 *     sandbox) and its setter notifies mounted viewers, so assignment
 *     is the whole interaction. Defining it as a property also means
 *     `window._vellumDebug.flags` prints its current value in DevTools
 *     rather than a bare function reference.
 *
 * Both are `enumerable` so the namespace is self-documenting: typing
 * `window._vellumDebug.flags` lists what can be toggled.
 */

import {
  isAppIframeSandboxDisabled,
  setAppIframeSandboxDisabled,
} from "@/lib/app-sandbox-debug-flag";
import { setImpersonatedAssistantVersion } from "@/lib/backwards-compat/impersonate-version-flag";

const ROOT_NS = "_vellumDebug";
const FLAGS_NS = "flags";
const SANDBOX_FLAG_NAME = "disableIframeSandbox";

/** The flag surface attached to `window._vellumDebug.flags`. */
export interface VellumDebugFlagsApi {
  /**
   * Override the assistant version every version gate sees.
   *
   *  - `impersonateVersion("0.8.6")` — set to that version + reload.
   *  - `impersonateVersion(null)`    — clear override + reload.
   *  - `impersonateVersion()`        — log + return current value
   *                                    (no mutation, no reload).
   */
  impersonateVersion(value?: string | null): string | null;
  /**
   * Drop the `sandbox` attribute from app iframes for this page load.
   * Only the literal `true` enables it; a reload restores the sandbox.
   *
   * @see {@link @/lib/app-sandbox-debug-flag} for the trade this makes.
   */
  disableIframeSandbox: boolean;
}

/**
 * Attach the `flags` namespace to `window._vellumDebug`, alongside the
 * chat-page-scoped `chat` / `events` / `api` namespaces.
 *
 * Merges into whatever is already on the root rather than replacing it,
 * so install order against the chat page's installer doesn't matter.
 * Safe to call more than once — the accessor is `configurable`, and
 * redefining it does not disturb a flag a developer has already set,
 * because the value lives in the flag module, not on this object.
 * No-op on the server.
 */
export function installVellumDebugFlags(): void {
  if (typeof window === "undefined") {
    return;
  }
  const win = window as Omit<Window, typeof ROOT_NS> & {
    [ROOT_NS]?: Record<string, unknown>;
  };
  const root = win[ROOT_NS] ?? {};
  const flags = (root[FLAGS_NS] as Record<string, unknown> | undefined) ?? {};

  flags.impersonateVersion = setImpersonatedAssistantVersion;
  Object.defineProperty(flags, SANDBOX_FLAG_NAME, {
    configurable: true,
    enumerable: true,
    get: isAppIframeSandboxDisabled,
    set: setAppIframeSandboxDisabled,
  });

  root[FLAGS_NS] = flags;
  win[ROOT_NS] = root;
}
