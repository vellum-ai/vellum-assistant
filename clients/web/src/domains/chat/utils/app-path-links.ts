/**
 * In-app destinations a markdown href can name: client routes under
 * `/assistant/` and `/account/`, written as a same-origin relative path or as
 * an http(s) URL on this origin / a vellum.ai host.
 *
 * Workspace file paths (`/workspace/...`) are not in-app routes; they stay
 * file links. Protocol-relative and other origin-escaping shapes are rejected
 * by `isAppRelativePath`.
 */

import { isAppRelativePath } from "@/utils/app-relative-path";

function pathnameOf(href: string): string {
  return href.split("#", 1)[0]?.split("?", 1)[0] ?? "";
}

/** Pathname of a client route, ignoring query string and fragment. */
export function isClientAppPathname(pathname: string): boolean {
  return (
    pathname === "/assistant" ||
    pathname === "/account" ||
    pathname.startsWith("/assistant/") ||
    pathname.startsWith("/account/")
  );
}

/**
 * Relative href that stays on this origin and names a client route
 * (`/assistant/conversations/conv-xyz`, `/account/login`).
 */
export function isClientAppPath(href: string): boolean {
  if (!isAppRelativePath(href)) {
    return false;
  }
  return isClientAppPathname(pathnameOf(href));
}

function isVellumAppHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "vellum.ai" || host.endsWith(".vellum.ai");
}

/**
 * The in-app path a markdown href should navigate to, or `null` when it is
 * not a client route. Relative paths are returned as written (query and
 * fragment included). Absolute http(s) URLs keep pathname + search + hash.
 */
export function toAppPathFromHref(href: string): string | null {
  const text = href.trim();
  if (text.length === 0) {
    return null;
  }
  if (isClientAppPath(text)) {
    return text;
  }
  if (!/^https?:\/\//i.test(text)) {
    return null;
  }
  try {
    const url = new URL(text);
    if (!isClientAppPathname(url.pathname)) {
      return null;
    }
    const sameOrigin =
      typeof window !== "undefined" && url.origin === window.location.origin;
    if (!sameOrigin && !isVellumAppHost(url.hostname)) {
      return null;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
