import { describe, expect, test } from "bun:test";

import {
  type AuthCookie,
  type CookieJar,
  clearSignInCookiesForHosts,
  cookieDomainMatchesHost,
  cookieRemovalUrl,
  createAuthPopupSignInTracker,
  isFirstPartyAuthHost,
  navigationDetailsFromArgs,
  selectSignInCookies,
  thirdPartyAuthHostFromUrl,
  trackAuthPopupSignInState,
} from "./auth-popup-session";

// A stand-in for `Session.cookies` that records what was removed.
const fakeJar = (
  cookies: AuthCookie[],
  opts: { failOn?: string } = {},
): CookieJar & { removed: Array<{ url: string; name: string }> } => {
  const removed: Array<{ url: string; name: string }> = [];
  return {
    removed,
    get: () => Promise.resolve(cookies),
    remove: (url: string, name: string) => {
      if (name === opts.failOn) {
        return Promise.reject(new Error("remove failed"));
      }
      removed.push({ url, name });
      return Promise.resolve();
    },
  };
};

// The close handler sweeps the jar asynchronously; let those turns settle.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// A stand-in for the popup BrowserWindow handed to `did-create-window`.
// Navigation events are kept apart so a test can reproduce a chain the way
// Electron reports it: where a navigation *starts* versus where it lands.
const fakePopup = () => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let closedListener: (() => void) | null = null;

  const emit = (event: string, ...args: unknown[]) =>
    listeners.get(event)?.forEach((listener) => listener(...args));

  return {
    start: (...args: unknown[]) => emit("did-start-navigation", ...args),
    redirect: (...args: unknown[]) => emit("did-redirect-navigation", ...args),
    // The whole-chain shorthand most tests want: a navigation that starts and
    // settles at the same URL.
    navigate: (...args: unknown[]) => {
      emit("did-start-navigation", ...args);
      emit("did-navigate", ...args);
    },
    close: () => closedListener?.(),
    window: {
      webContents: {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          const existing = listeners.get(event);
          if (existing) existing.push(listener);
          else listeners.set(event, [listener]);
        },
      },
      once: (_event: "closed", listener: () => void) => {
        closedListener = listener;
      },
    },
  };
};

describe("isFirstPartyAuthHost", () => {
  test("covers Vellum hosts and the loopback callback listener", () => {
    expect(isFirstPartyAuthHost("vellum.ai")).toBe(true);
    expect(isFirstPartyAuthHost("www.vellum.ai")).toBe(true);
    expect(isFirstPartyAuthHost("staging-platform.vellum.ai")).toBe(true);
    expect(isFirstPartyAuthHost("localhost")).toBe(true);
    expect(isFirstPartyAuthHost("127.0.0.1")).toBe(true);
  });

  test("does not treat a lookalike suffix as first-party", () => {
    expect(isFirstPartyAuthHost("notvellum.ai")).toBe(false);
    expect(isFirstPartyAuthHost("vellum.ai.evil.com")).toBe(false);
    expect(isFirstPartyAuthHost("login.microsoftonline.com")).toBe(false);
  });
});

describe("thirdPartyAuthHostFromUrl", () => {
  test("returns the host for third-party http(s) navigations", () => {
    expect(
      thirdPartyAuthHostFromUrl(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?prompt=select_account",
      ),
    ).toBe("login.microsoftonline.com");
  });

  test("ignores first-party, non-web, and unparseable URLs", () => {
    expect(thirdPartyAuthHostFromUrl("https://www.vellum.ai/connect/x")).toBe(
      null,
    );
    expect(thirdPartyAuthHostFromUrl("app://vellum.ai/assistant")).toBe(null);
    expect(thirdPartyAuthHostFromUrl("about:blank")).toBe(null);
    expect(thirdPartyAuthHostFromUrl("not a url")).toBe(null);
  });
});

describe("cookieDomainMatchesHost", () => {
  test("matches the host itself and parent domains", () => {
    expect(
      cookieDomainMatchesHost(
        "login.microsoftonline.com",
        "login.microsoftonline.com",
      ),
    ).toBe(true);
    expect(cookieDomainMatchesHost(".google.com", "accounts.google.com")).toBe(
      true,
    );
  });

  test("does not match a child domain or an unrelated one", () => {
    expect(cookieDomainMatchesHost("accounts.google.com", "google.com")).toBe(
      false,
    );
    expect(cookieDomainMatchesHost("evil-google.com", "google.com")).toBe(
      false,
    );
  });
});

describe("selectSignInCookies", () => {
  test("selects registrable-domain cookies a host-scoped lookup would miss", () => {
    const selected = selectSignInCookies(
      [
        { name: "SID", domain: ".google.com", path: "/" },
        { name: "ESTSAUTH", domain: "login.microsoftonline.com", path: "/" },
      ],
      ["accounts.google.com", "login.microsoftonline.com"],
    );
    expect(selected.map((c) => c.name).sort()).toEqual(["ESTSAUTH", "SID"]);
  });

  test("never selects a Vellum or loopback cookie", () => {
    const selected = selectSignInCookies(
      [
        { name: "vellum_session", domain: ".vellum.ai", path: "/" },
        { name: "dev", domain: "localhost", path: "/" },
        { name: "ESTSAUTH", domain: "login.microsoftonline.com", path: "/" },
      ],
      ["login.microsoftonline.com", "www.vellum.ai", "localhost"],
    );
    expect(selected.map((c) => c.name)).toEqual(["ESTSAUTH"]);
  });

  test("leaves unrelated third-party cookies alone", () => {
    const selected = selectSignInCookies(
      [{ name: "sess", domain: "slack.com", path: "/" }],
      ["login.microsoftonline.com"],
    );
    expect(selected).toEqual([]);
  });
});

describe("cookieRemovalUrl", () => {
  test("addresses the cookie by its own domain and path", () => {
    expect(
      cookieRemovalUrl({ name: "x", domain: ".google.com", path: "/accounts" }),
    ).toBe("https://google.com/accounts");
  });

  test("falls back to the root path when none is set", () => {
    expect(cookieRemovalUrl({ name: "x", domain: "login.live.com" })).toBe(
      "https://login.live.com/",
    );
  });
});

describe("clearSignInCookiesForHosts", () => {
  test("removes every matching cookie and reports the count", async () => {
    const jar = fakeJar([
      { name: "ESTSAUTH", domain: "login.microsoftonline.com", path: "/" },
      {
        name: "ESTSAUTHPERSISTENT",
        domain: "login.microsoftonline.com",
        path: "/",
      },
      { name: "vellum_session", domain: ".vellum.ai", path: "/" },
    ]);

    const removed = await clearSignInCookiesForHosts(jar, [
      "login.microsoftonline.com",
    ]);

    expect(removed).toBe(2);
    expect(jar.removed).toEqual([
      { url: "https://login.microsoftonline.com/", name: "ESTSAUTH" },
      {
        url: "https://login.microsoftonline.com/",
        name: "ESTSAUTHPERSISTENT",
      },
    ]);
  });

  test("keeps sweeping after a failed removal", async () => {
    const jar = fakeJar(
      [
        { name: "a", domain: "login.microsoftonline.com", path: "/" },
        { name: "b", domain: "login.microsoftonline.com", path: "/" },
      ],
      { failOn: "a" },
    );
    const errors: unknown[] = [];

    const removed = await clearSignInCookiesForHosts(
      jar,
      ["login.microsoftonline.com"],
      (err) => errors.push(err),
    );

    expect(removed).toBe(1);
    expect(jar.removed.map((r) => r.name)).toEqual(["b"]);
    expect(errors).toHaveLength(1);
  });

  test("does not touch the jar when no third-party host was visited", async () => {
    const jar = fakeJar([{ name: "x", domain: "example.com", path: "/" }]);
    expect(await clearSignInCookiesForHosts(jar, [])).toBe(0);
    expect(jar.removed).toEqual([]);
  });
});

describe("navigationDetailsFromArgs", () => {
  test("reads the positional (event, url) form", () => {
    expect(navigationDetailsFromArgs([{}, "https://example.com/a"])).toEqual({
      url: "https://example.com/a",
      isMainFrame: true,
    });
  });

  test("reads the details-object form", () => {
    expect(
      navigationDetailsFromArgs([{ url: "https://example.com/b" }]),
    ).toEqual({ url: "https://example.com/b", isMainFrame: true });
  });

  test("reads the frame flag from either shape", () => {
    // (event, url, isInPlace, isMainFrame, …)
    expect(
      navigationDetailsFromArgs([{}, "https://example.com/c", false, false])
        .isMainFrame,
    ).toBe(false);
    expect(
      navigationDetailsFromArgs([
        { url: "https://example.com/d", isMainFrame: false },
      ]).isMainFrame,
    ).toBe(false);
  });

  test("assumes the main frame when the event carries no flag", () => {
    // `did-navigate`'s positional form is (event, url, statusCode, statusText).
    expect(
      navigationDetailsFromArgs([{}, "https://example.com/e", 200, "OK"]),
    ).toEqual({ url: "https://example.com/e", isMainFrame: true });
  });

  test("returns null when no URL is present", () => {
    expect(navigationDetailsFromArgs([{}, 302]).url).toBe(null);
  });
});

describe("trackAuthPopupSignInState", () => {
  test("clears the sign-in cookies of every host the popup passed through", async () => {
    const popup = fakePopup();
    const jar = fakeJar([
      { name: "ESTSAUTH", domain: "login.microsoftonline.com", path: "/" },
      { name: "MSPAuth", domain: ".login.live.com", path: "/" },
      { name: "vellum_session", domain: ".vellum.ai", path: "/" },
    ]);
    let clearedHosts: readonly string[] = [];

    trackAuthPopupSignInState(popup.window, {
      cookies: () => jar,
      onCleared: (hosts) => (clearedHosts = hosts),
    });

    // The connect URL starts first-party, redirects into Microsoft, and lands
    // back on the Vellum completion page.
    popup.navigate({}, "https://www.vellum.ai/connect/abc");
    popup.navigate(
      {},
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    popup.navigate({ url: "https://login.live.com/oauth20_authorize.srf" });
    popup.navigate({}, "https://www.vellum.ai/account/oauth/popup-complete");
    popup.close();

    await flush();

    expect([...clearedHosts].sort()).toEqual([
      "login.live.com",
      "login.microsoftonline.com",
    ]);
    expect(jar.removed.map((r) => r.name).sort()).toEqual([
      "ESTSAUTH",
      "MSPAuth",
    ]);
  });

  test("records a provider that only ever appears as a navigation's start", async () => {
    const popup = fakePopup();
    const jar = fakeJar([
      { name: "ESTSAUTH", domain: "login.microsoftonline.com", path: "/" },
    ]);

    trackAuthPopupSignInState(popup.window, { cookies: () => jar });

    // The stale-cookie case: a live SSO session bounces the authorize request
    // straight back to the first-party callback. Microsoft is never a redirect
    // target and never the final URL — only where the navigation began.
    popup.start(
      {},
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    popup.redirect(
      {},
      "https://www.vellum.ai/account/oauth/popup-complete?oauth_status=connected",
    );
    popup.navigate(
      {},
      "https://www.vellum.ai/account/oauth/popup-complete?oauth_status=connected",
    );
    popup.close();

    await flush();

    expect(jar.removed.map((r) => r.name)).toEqual(["ESTSAUTH"]);
  });

  test("ignores subframe navigations", async () => {
    const popup = fakePopup();
    const jar = fakeJar([{ name: "tracker", domain: "ads.example.com" }]);

    trackAuthPopupSignInState(popup.window, { cookies: () => jar });

    // (event, url, isInPlace, isMainFrame)
    popup.start({}, "https://ads.example.com/pixel", false, false);
    popup.close();

    await flush();

    expect(jar.removed).toEqual([]);
  });

  test("leaves the jar untouched for a popup that never left first-party hosts", async () => {
    const popup = fakePopup();
    const jar = fakeJar([
      { name: "vellum_session", domain: ".vellum.ai", path: "/" },
    ]);

    trackAuthPopupSignInState(popup.window, { cookies: () => jar });

    popup.navigate({}, "https://www.vellum.ai/account/settings");
    popup.close();

    await flush();

    expect(jar.removed).toEqual([]);
  });

  test("reports a sweep failure instead of throwing at the close handler", async () => {
    const popup = fakePopup();
    const errors: unknown[] = [];

    trackAuthPopupSignInState(popup.window, {
      cookies: () => ({
        get: () => Promise.reject(new Error("session gone")),
        remove: () => Promise.resolve(),
      }),
      onError: (err) => errors.push(err),
    });

    popup.navigate({}, "https://login.microsoftonline.com/common");
    popup.close();

    await flush();

    expect(errors).toHaveLength(1);
  });
});

describe("createAuthPopupSignInTracker", () => {
  const microsoftCookie = {
    name: "ESTSAUTH",
    domain: "login.microsoftonline.com",
    path: "/",
  };

  test("sweeps a child window the window-open handler marked", async () => {
    const popup = fakePopup();
    const jar = fakeJar([microsoftCookie]);
    const tracker = createAuthPopupSignInTracker({ cookies: () => jar });

    tracker.markNextChildAsAuthPopup();
    tracker.trackCreatedChild(popup.window);

    popup.navigate({}, "https://login.microsoftonline.com/common");
    popup.close();

    await flush();

    expect(jar.removed.map((r) => r.name)).toEqual(["ESTSAUTH"]);
  });

  test("leaves an unmarked child window alone", async () => {
    // A plain link popup — a Slack app-setup page, a GitHub repo. Closing it
    // must not sign the user out of a service they signed in to on purpose.
    const popup = fakePopup();
    const jar = fakeJar([{ name: "user_session", domain: ".github.com" }]);
    const tracker = createAuthPopupSignInTracker({ cookies: () => jar });

    tracker.trackCreatedChild(popup.window);

    popup.navigate({}, "https://github.com/vellum-ai/vellum-assistant");
    popup.close();

    await flush();

    expect(jar.removed).toEqual([]);
  });

  test("the mark applies to one child window only", async () => {
    const authPopup = fakePopup();
    const linkPopup = fakePopup();
    const jar = fakeJar([
      microsoftCookie,
      { name: "user_session", domain: ".github.com" },
    ]);
    const tracker = createAuthPopupSignInTracker({ cookies: () => jar });

    tracker.markNextChildAsAuthPopup();
    tracker.trackCreatedChild(authPopup.window);
    tracker.trackCreatedChild(linkPopup.window);

    linkPopup.navigate({}, "https://github.com/vellum-ai/vellum-assistant");
    linkPopup.close();
    authPopup.navigate({}, "https://login.microsoftonline.com/common");
    authPopup.close();

    await flush();

    expect(jar.removed.map((r) => r.name)).toEqual(["ESTSAUTH"]);
  });
});
