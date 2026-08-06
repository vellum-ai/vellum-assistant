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

export interface NavigationDetails {
  url: string | null;
  isMainFrame: boolean;
}

/**
 * Pull the navigated URL and frame flag out of a webContents navigation
 * event's arguments.
 *
 * Electron has moved several navigation events from the positional
 * `(event, url, isInPlace, isMainFrame, …)` form to a single details object
 * carrying the same fields, and the two forms coexist across versions. Reading
 * whichever shape arrives keeps the tracker correct either way instead of
 * silently recording nothing. `isMainFrame` defaults to true when the event
 * does not carry it — `did-navigate` only ever fires for the main frame, and
 * its positional slots hold a status code and text rather than frame flags.
 */
export const navigationDetailsFromArgs = (
  args: readonly unknown[],
): NavigationDetails => {
  const [first, second] = args;

  if (typeof second === "string") {
    return {
      url: second,
      isMainFrame: typeof args[3] === "boolean" ? args[3] : true,
    };
  }

  if (first && typeof first === "object") {
    const details = first as { url?: unknown; isMainFrame?: unknown };
    if (typeof details.url === "string") {
      return {
        url: details.url,
        isMainFrame:
          typeof details.isMainFrame === "boolean" ? details.isMainFrame : true,
      };
    }
  }

  return { url: null, isMainFrame: true };
};

/**
 * Watch an authorization popup and clear the sign-in state it accumulated once
 * it closes.
 *
 * Prefer `createAuthPopupSignInTracker` at a call site that also owns the
 * window-open handler: tracking every child window indiscriminately would sweep
 * the cookies of plain link popups too.
 */
export const trackAuthPopupSignInState = (
  popup: AuthPopupWindow,
  deps: AuthPopupTrackingDeps,
): void => {
  const visited = new Set<string>();

  const record = (...args: unknown[]): void => {
    const { url, isMainFrame } = navigationDetailsFromArgs(args);
    if (!url || !isMainFrame) return;
    const host = thirdPartyAuthHostFromUrl(url);
    if (host) visited.add(host);
  };

  // All three events are needed to see the whole chain, because each reports a
  // different point of it: `did-start-navigation` carries the URL a navigation
  // begins at, `did-redirect-navigation` the target of each hop, and
  // `did-navigate` the URL it settled on. The start event is what catches the
  // case this whole module exists for — an authorize request that a live SSO
  // cookie bounces straight back to the first-party callback, where the
  // provider's host is *only* ever the initial request and never a redirect
  // target or a final URL.
  popup.webContents.on("did-start-navigation", record);
  popup.webContents.on("did-redirect-navigation", record);
  popup.webContents.on("did-navigate", record);

  popup.once("closed", () => {
    if (visited.size === 0) return;
    const hosts = [...visited];
    void clearSignInCookiesForHosts(deps.cookies(), hosts, deps.onError)
      .then((removed) => deps.onCleared?.(hosts, removed))
      .catch((err: unknown) => deps.onError?.(err));
  });
};

export interface AuthPopupSignInTracker {
  /**
   * Call from the window-open handler when the window it is about to allow is
   * an authorization surface. Applies to the next child window only.
   */
  markNextChildAsAuthPopup(): void;
  /** Call from `did-create-window`. Tracks the window only if it was marked. */
  trackCreatedChild(popup: AuthPopupWindow): void;
}

/**
 * Pair a window-open handler with a `did-create-window` listener so only the
 * child windows the handler identified as authorization surfaces get their
 * sign-in cookies swept.
 *
 * The gate matters because a renderer opens child windows for ordinary links
 * too — a Slack app-setup page, a GitHub repo, a Discord invite. Sweeping those
 * would sign the user out of services they deliberately signed in to, which is
 * the opposite of the fix. The two callbacks fire in order for the same window
 * (handler first, then the event), so a single-slot flag correlates them; the
 * flag is consumed on read, so an unmarked window is never tracked.
 *
 * Create one tracker per opener webContents, so the flag cannot cross windows.
 */
export const createAuthPopupSignInTracker = (
  deps: AuthPopupTrackingDeps,
): AuthPopupSignInTracker => {
  let nextChildIsAuthPopup = false;

  return {
    markNextChildAsAuthPopup: () => {
      nextChildIsAuthPopup = true;
    },
    trackCreatedChild: (popup) => {
      const isAuthPopup = nextChildIsAuthPopup;
      nextChildIsAuthPopup = false;
      if (!isAuthPopup) return;
      trackAuthPopupSignInState(popup, deps);
    },
  };
};
