/**
 * Last-mile policy for CDP commands the extension will send through
 * chrome.debugger. Unknown methods and missing tab bindings fail closed
 * here even if the daemon asked for them.
 */

/** Explicit opt-in to the focused tab. Must match the daemon sentinel. */
export const ACTIVE_TAB_SESSION_ID = "active";

const VELLUM_WITHOUT_TARGET = new Set([
  "Vellum.createTab",
  "Vellum.findTab",
  "Vellum.listTabs",
  "Vellum.selectTab",
  "Vellum.closeTab",
]);

const VELLUM_WITH_TARGET = new Set(["Vellum.attach", "Vellum.detach"]);

const ALLOWED_PREFIXES = [
  "Page.",
  "Runtime.",
  "DOM.",
  "Input.",
  "Accessibility.",
] as const;

const ALLOWED_NETWORK = new Set([
  "Network.enable",
  "Network.disable",
  "Network.getAllCookies",
  "Network.getResponseBody",
]);

export function isAllowedCdpMethod(method: string): boolean {
  if (VELLUM_WITHOUT_TARGET.has(method) || VELLUM_WITH_TARGET.has(method)) {
    return true;
  }
  if (ALLOWED_NETWORK.has(method)) {
    return true;
  }
  return ALLOWED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export function commandRequiresTabBinding(method: string): boolean {
  if (VELLUM_WITHOUT_TARGET.has(method)) {
    return false;
  }
  return isAllowedCdpMethod(method);
}

export function tabBindingError(
  method: string,
  cdpSessionId: string | undefined,
): string | undefined {
  if (!commandRequiresTabBinding(method)) {
    return undefined;
  }
  if (cdpSessionId == null || cdpSessionId.trim() === "") {
    return "cdpSessionId (tab binding) is required";
  }
  return undefined;
}
