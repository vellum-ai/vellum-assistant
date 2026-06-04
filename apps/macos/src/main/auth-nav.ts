import { type AllowedOrigin, isAllowedOrigin } from "./app-origin";

/**
 * Navigation-guard decision logic for the main window, extracted so it can be
 * unit-tested without booting the app.
 *
 * Normally the main window may only navigate within the app's own origin;
 * cross-origin top-level navigations are ejected to the system browser. During
 * a sign-in, though, the window must follow the OAuth provider chain
 * (WorkOS → Google/Apple → back to our callback) as in-window navigations — so
 * while `authFlowActive` is set, cross-origin http(s) hops are allowed.
 */
export type NavigationDecision =
  | { kind: "allow" } // proceed in-window
  | { kind: "external"; url: string } // eject to the system browser
  | { kind: "block" }; // preventDefault, no fallback

export const decideNavigation = (
  url: string,
  allowed: AllowedOrigin,
  authFlowActive: boolean,
): NavigationDecision => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { kind: "block" };
  }
  if (isAllowedOrigin(target, allowed)) return { kind: "allow" };

  const isHttp = target.protocol === "https:" || target.protocol === "http:";
  if (authFlowActive && isHttp) return { kind: "allow" };
  if (isHttp) return { kind: "external", url };
  return { kind: "block" };
};

/**
 * On a committed top-level navigation (`did-navigate`), decide whether an
 * in-progress sign-in has completed and the relaxed guard should re-arm.
 *
 * The guard re-arms only once the flow has actually left to a provider domain
 * (`sawExternal`) and then returned to the app origin (the OAuth callback) —
 * never on the initial same-origin POST that kicks the flow off. Returns the
 * updated `sawExternal` so the caller can thread the per-flow state.
 */
export const advanceAuthFlow = (
  url: string,
  allowed: AllowedOrigin,
  sawExternal: boolean,
): { end: boolean; sawExternal: boolean } => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { end: false, sawExternal };
  }
  if (!isAllowedOrigin(target, allowed)) {
    return { end: false, sawExternal: true };
  }
  return { end: sawExternal, sawExternal };
};
