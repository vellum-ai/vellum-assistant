import { Capacitor } from "@capacitor/core";

import { openUrl } from "@/runtime/browser";

const OAUTH_POPUP_FEATURES = "width=500,height=600";

function parseHttpUrl(href: string | undefined): URL | null {
  if (!href) {
    return null;
  }

  let url: URL;
  try {
    const base =
      typeof window === "undefined" ? "http://localhost" : window.location.origin;
    url = new URL(href, base);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  return url;
}

export function shouldOpenMarkdownLinkInOAuthPopup(
  href: string | undefined,
): boolean {
  const url = parseHttpUrl(href);
  if (!url) {
    return false;
  }

  const path = url.pathname.toLowerCase();
  const hasOAuthCodeParams =
    url.searchParams.get("response_type") === "code" &&
    url.searchParams.has("client_id") &&
    url.searchParams.has("redirect_uri");

  return (
    hasOAuthCodeParams ||
    (
      url.searchParams.has("client_id") &&
      url.searchParams.has("redirect_uri") &&
      /oauth|authorize|auth/.test(path)
    )
  );
}

export function getSameOriginRoutePath(href: string | undefined): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const url = parseHttpUrl(href);
  if (!url || url.origin !== window.location.origin) {
    return null;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function getHttpUrl(href: string | undefined): string | null {
  return parseHttpUrl(href)?.href ?? null;
}

export function openOAuthUrlInPopup(
  href: string | undefined,
): boolean {
  if (!shouldOpenMarkdownLinkInOAuthPopup(href)) {
    return false;
  }

  // Capacitor iOS: WKWebView's `window.open` returns null because the default
  // `WKUIDelegate.createWebViewWith` returns nil. Route the OAuth start URL
  // through `openUrl`, which presents `SFSafariViewController` via
  // `@capacitor/browser` — the same surface used by the static-UI integration
  // OAuth flow and Stripe checkout.
  if (Capacitor.isNativePlatform()) {
    const url = getHttpUrl(href);
    if (!url) {
      return false;
    }
    void openUrl(url);
    return true;
  }

  const popup = window.open(href, "_blank", OAUTH_POPUP_FEATURES);
  if (popup === null) {
    return false;
  }

  popup.focus();
  return true;
}

export function openMarkdownOAuthLinkInPopup(
  href: string | undefined,
): boolean {
  return openOAuthUrlInPopup(href);
}

/**
 * Open an external http(s) URL in the browser: OAuth-shaped URLs get the
 * sized popup, everything else a new tab. Returns false when the browser
 * blocked the open — automatic opens (e.g. driven by an SSE event) carry
 * no user activation, so callers should surface a clickable fallback that
 * re-invokes this from a real click.
 */
export function openUrlInPopupOrTab(url: string): boolean {
  if (openOAuthUrlInPopup(url)) {
    return true;
  }

  const popup = window.open(url, "_blank");
  if (popup === null) {
    return false;
  }

  popup.focus();
  return true;
}

export type OpenUrlDispatchOutcome =
  | { kind: "routed" }
  | { kind: "opened" }
  | { kind: "invalid" }
  | { kind: "blocked"; url: string };

/**
 * Route an `open_url` directive to the right surface: same-origin URLs go
 * through the client router, native platforms hand off to the runtime
 * opener, and everything else opens via `openUrlInPopupOrTab`. Shared by
 * the chat stream handler and the root-level directive subscriber so the
 * two paths cannot drift.
 */
export function dispatchOpenUrl(
  href: string,
  opts: { isNative: boolean; push: (path: string) => void },
): OpenUrlDispatchOutcome {
  const sameOriginRoutePath = getSameOriginRoutePath(href);
  if (sameOriginRoutePath) {
    opts.push(sameOriginRoutePath);
    return { kind: "routed" };
  }

  const url = getHttpUrl(href);
  if (!url) {
    return { kind: "invalid" };
  }

  if (opts.isNative) {
    void openUrl(url);
    return { kind: "opened" };
  }

  if (!openUrlInPopupOrTab(url)) {
    // No user activation behind an SSE-driven open, so browsers commonly
    // block it. Callers surface the URL for a click-driven retry.
    return { kind: "blocked", url };
  }

  return { kind: "opened" };
}
