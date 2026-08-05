/**
 * Sign-in isolation for third-party OAuth popups.
 *
 * The desktop shells open the web app's connect flows (`window.open(...)` →
 * the provider's authorize URL) as in-app child windows. Those windows share
 * the app's persistent session, so the identity provider's SSO cookie — the
 * Microsoft `ESTSAUTH*` pair, Google's `SID`, and their equivalents — is
 * written into the app's cookie jar and survives for the life of the install.
 *
 * In a real browser that is fine: the user has an address bar, a profile
 * switcher, and the provider's own sign-out page to fall back on. An in-app
 * popup has none of that chrome, so the first account a user connects becomes
 * the only account they can ever connect: every later authorization silently
 * single-signs-on as that identity, and Microsoft in particular skips the
 * account picker entirely when a live session cookie is present. That is the
 * "can't register a second Outlook account from the desktop app" report.
 *
 * The fix is to treat each authorization window as a throwaway sign-in
 * surface: track the third-party hosts it navigates through, and drop their
 * cookies from the session once the window closes. The next connect therefore
 * starts signed out and the provider asks who you are. First-party Vellum
 * hosts (and loopback, used by the local OAuth callback listener) are never
 * touched, so the app's own session is unaffected.
 *
 * Everything here is typed against minimal structural interfaces rather than
 * Electron's classes so the package stays a dependency-free leaf and the logic
 * is unit-testable without booting a browser process.
 */

/** The cookie fields this module reads. Structural subset of Electron's `Cookie`. */
export interface AuthCookie {
  name: string;
  domain?: string;
  path?: string;
}

/** Structural subset of Electron's `Session.cookies`. */
export interface CookieJar {
  get(filter: { domain?: string }): Promise<AuthCookie[]>;
  remove(url: string, name: string): Promise<void>;
}

/** Structural subset of the `BrowserWindow` handed to `did-create-window`. */
export interface AuthPopupWindow {
  webContents: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  once(event: "closed", listener: () => void): unknown;
}

export interface AuthPopupTrackingDeps {
  /** Resolved lazily: the session outlives the popup, the popup does not. */
  cookies: () => CookieJar;
  /** Reported after a successful sweep, for the main-process log. */
  onCleared?: (hosts: readonly string[], removed: number) => void;
  onError?: (err: unknown) => void;
}

/**
 * Hosts that belong to Vellum itself, or to the loopback listener the local
 * OAuth callback binds. Their cookies carry the user's own session and must
 * survive an authorization window.
 */
export const isFirstPartyAuthHost = (host: string): boolean => {
  const normalized = host.toLowerCase();
  return (
    normalized === "vellum.ai" ||
    normalized.endsWith(".vellum.ai") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
};

/**
 * The third-party host of an http(s) navigation, or null when the URL is
 * first-party, unparseable, or a non-web scheme (`about:blank` starts every
 * popup; custom schemes are already blocked by the window-open handler).
 */
export const thirdPartyAuthHostFromUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || isFirstPartyAuthHost(host)) {
    return null;
  }
  return host;
};

/**
 * Standard cookie domain-match: a cookie is in scope for a host when the
 * domains are equal or the cookie's domain is a parent of the host. Applied to
 * the domain the browser already accepted, so no public-suffix check is needed
 * here — `.microsoftonline.com` covers `login.microsoftonline.com`, while
 * `login.microsoftonline.com` does not cover `microsoftonline.com`.
 */
export const cookieDomainMatchesHost = (
  cookieDomain: string,
  host: string,
): boolean => {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  if (!domain) return false;
  return target === domain || target.endsWith(`.${domain}`);
};

/**
 * The cookies to drop: every cookie whose domain covers one of the hosts the
 * authorization window visited. Selecting from the full jar (rather than
 * querying per host) is what catches registrable-domain cookies such as
 * `.google.com`, which a host-scoped lookup for `accounts.google.com` misses.
 */
export const selectSignInCookies = (
  cookies: readonly AuthCookie[],
  hosts: readonly string[],
): AuthCookie[] =>
  cookies.filter((cookie) => {
    const domain = cookie.domain;
    if (!domain) return false;
    const bare = domain.replace(/^\./, "").toLowerCase();
    if (isFirstPartyAuthHost(bare)) return false;
    return hosts.some((host) => cookieDomainMatchesHost(domain, host));
  });

/** The URL `cookies.remove` needs to address a cookie: its own domain and path. */
export const cookieRemovalUrl = (cookie: AuthCookie): string => {
  const domain = (cookie.domain ?? "").replace(/^\./, "");
  const path = cookie.path && cookie.path.startsWith("/") ? cookie.path : "/";
  return `https://${domain}${path}`;
};

/**
 * Drop the sign-in cookies the given hosts left behind. Best-effort: a single
 * failed removal must not abort the sweep, since a half-cleared jar is what
 * leaves the next authorization stuck on the previous account.
 *
 * Returns the number of cookies removed.
 */
export const clearSignInCookiesForHosts = async (
  jar: CookieJar,
  hosts: readonly string[],
  onError?: (err: unknown) => void,
): Promise<number> => {
  if (hosts.length === 0) return 0;

  const all = await jar.get({});
  const doomed = selectSignInCookies(all, hosts);

  let removed = 0;
  for (const cookie of doomed) {
    try {
      await jar.remove(cookieRemovalUrl(cookie), cookie.name);
      removed += 1;
    } catch (err) {
      onError?.(err);
    }
  }
  return removed;
};

/**
 * Pull the navigated URL out of a webContents navigation event's arguments.
 *
 * Electron has moved several navigation events from the positional
 * `(event, url, …)` form to a single details object carrying `url`, and the
 * two forms coexist across versions. Reading whichever shape arrives keeps the
 * tracker correct either way instead of silently recording nothing.
 */
export const navigationUrlFromArgs = (
  args: readonly unknown[],
): string | null => {
  for (const arg of args) {
    if (typeof arg === "string") return arg;
    if (arg && typeof arg === "object") {
      const { url } = arg as { url?: unknown };
      if (typeof url === "string") return url;
    }
  }
  return null;
};

/**
 * Watch an authorization popup and clear the sign-in state it accumulated once
 * it closes. Wire this from the main process's `did-create-window` handler so
 * every child window the renderer opens is covered.
 */
export const trackAuthPopupSignInState = (
  popup: AuthPopupWindow,
  deps: AuthPopupTrackingDeps,
): void => {
  const visited = new Set<string>();

  const record = (...args: unknown[]): void => {
    const url = navigationUrlFromArgs(args);
    if (!url) return;
    const host = thirdPartyAuthHostFromUrl(url);
    if (host) visited.add(host);
  };

  // `did-redirect-navigation` catches the hosts a 302 chain passes through —
  // the provider's authorize endpoint is often only ever an intermediate hop.
  popup.webContents.on("did-navigate", record);
  popup.webContents.on("did-redirect-navigation", record);

  popup.once("closed", () => {
    if (visited.size === 0) return;
    const hosts = [...visited];
    void clearSignInCookiesForHosts(deps.cookies(), hosts, deps.onError)
      .then((removed) => deps.onCleared?.(hosts, removed))
      .catch((err: unknown) => deps.onError?.(err));
  });
};
