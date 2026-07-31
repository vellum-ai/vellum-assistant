import { type AllowedOrigin, isAllowedOrigin } from "./app-origin";

/**
 * Navigation-guard decision logic for the main window, extracted so it can be
 * unit-tested without booting the app.
 *
 * The main window may only navigate within the app's own origin; cross-origin
 * http(s) navigations are ejected to the system browser, and non-http schemes
 * are blocked outright.
 */
export type NavigationDecision =
  | { kind: "allow" } // proceed in-window
  | { kind: "external"; url: string } // eject to the system browser
  | { kind: "block" }; // preventDefault, no fallback

export const decideNavigation = (
  url: string,
  allowed: AllowedOrigin,
): NavigationDecision => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { kind: "block" };
  }
  if (isAllowedOrigin(target, allowed)) return { kind: "allow" };

  const isHttp = target.protocol === "https:" || target.protocol === "http:";
  if (isHttp) return { kind: "external", url };
  return { kind: "block" };
};
