import { describe, expect, it } from "bun:test";

import {
  type AuthChallenge,
  detectAuthChallenge,
  formatAuthChallenge,
  identifyService,
  isAuthUrl,
} from "../auth-detector.js";
import type { Page } from "../browser-manager.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal mock Page whose `url()` returns the given URL and
 * `evaluate()` runs a callback that simulates a DOM structure.
 *
 * `evaluateResult` is the value that `page.evaluate()` will resolve with,
 * matching the shape returned by the DOM_DETECT_EXPRESSION IIFE inside
 * auth-detector.ts.
 */
function mockPage(url: string, evaluateResult: unknown = null): Page {
  return {
    close: async () => {},
    isClosed: () => false,
    goto: async () => null,
    title: async () => "",
    url: () => url,
    evaluate: async (_expr: string) => evaluateResult,
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    selectOption: async () => [] as string[],
    hover: async () => {},
    waitForSelector: async () => null,
    waitForFunction: async () => null,
    route: async () => {},
    unroute: async () => {},
    screenshot: async () => Buffer.from(""),
    keyboard: { press: async () => {} },
    mouse: {
      click: async () => {},
      move: async () => {},
      wheel: async () => {},
    },
    bringToFront: async () => {},
    on: () => {},
  };
}

// ── Service identification ───────────────────────────────────────────

describe("identifyService", () => {
  it("identifies Google from accounts.google.com", () => {
    expect(
      identifyService("https://accounts.google.com/v3/signin/identifier"),
    ).toBe("Google");
  });

  it("identifies GitHub from github.com/login", () => {
    expect(identifyService("https://github.com/login")).toBe("GitHub");
  });

  it("identifies GitHub from github.com/session", () => {
    expect(identifyService("https://github.com/session")).toBe("GitHub");
  });

  it("does not identify GitHub from regular github.com pages", () => {
    expect(
      identifyService("https://github.com/vellum-ai/vellum-assistant"),
    ).toBeUndefined();
    expect(identifyService("https://github.com/pulls")).toBeUndefined();
    expect(identifyService("https://github.com/")).toBeUndefined();
  });

  it("identifies Microsoft from login.microsoftonline.com", () => {
    expect(
      identifyService(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      ),
    ).toBe("Microsoft");
  });

  it("identifies Apple from appleid.apple.com", () => {
    expect(identifyService("https://appleid.apple.com/auth/authorize")).toBe(
      "Apple",
    );
  });

  it("identifies Okta", () => {
    expect(identifyService("https://mycompany.okta.com/login/login.htm")).toBe(
      "Okta",
    );
  });

  it("returns undefined for unknown domains", () => {
    expect(identifyService("https://example.com/dashboard")).toBeUndefined();
  });

  it("does not match service patterns in query parameters", () => {
    expect(
      identifyService(
        "https://example.com/page?redirect=https://accounts.google.com",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for invalid URLs", () => {
    expect(identifyService("not-a-url")).toBeUndefined();
  });
});

// ── URL auth-pattern matching ────────────────────────────────────────

describe("isAuthUrl", () => {
  it("matches known service URLs", () => {
    expect(isAuthUrl("https://accounts.google.com/ServiceLogin")).toBe(true);
    expect(isAuthUrl("https://github.com/login")).toBe(true);
    expect(isAuthUrl("https://login.microsoftonline.com/common/oauth2")).toBe(
      true,
    );
  });

  it("matches generic /login path", () => {
    expect(isAuthUrl("https://example.com/login")).toBe(true);
    expect(isAuthUrl("https://example.com/user/login?next=/")).toBe(true);
  });

  it("matches generic /signin path", () => {
    expect(isAuthUrl("https://example.com/signin")).toBe(true);
  });

  it("matches generic /sign-in path", () => {
    expect(isAuthUrl("https://example.com/sign-in")).toBe(true);
  });

  it("matches /auth path", () => {
    expect(isAuthUrl("https://example.com/auth/callback")).toBe(true);
  });

  it("matches /oauth path", () => {
    expect(isAuthUrl("https://example.com/oauth/authorize")).toBe(true);
  });

  it("matches /sso path", () => {
    expect(isAuthUrl("https://example.com/sso/login")).toBe(true);
  });

  it("does not treat regular github.com URLs as auth URLs", () => {
    expect(isAuthUrl("https://github.com/vellum-ai/vellum-assistant")).toBe(
      false,
    );
    expect(isAuthUrl("https://github.com/pulls")).toBe(false);
    expect(isAuthUrl("https://github.com/")).toBe(false);
    expect(isAuthUrl("https://github.com/notifications")).toBe(false);
  });

  it("does not match unrelated URLs", () => {
    expect(isAuthUrl("https://example.com/dashboard")).toBe(false);
    expect(isAuthUrl("https://example.com/blog/authentication-tips")).toBe(
      false,
    );
    expect(isAuthUrl("https://example.com/")).toBe(false);
  });

  it("does not false-positive on auth-like words in query parameters", () => {
    expect(isAuthUrl("https://example.com/dashboard?redirect=/login")).toBe(
      false,
    );
    expect(isAuthUrl("https://example.com/home?next=/signin")).toBe(false);
    expect(isAuthUrl("https://example.com/page?return_to=/auth/callback")).toBe(
      false,
    );
  });

  it("does not false-positive on auth-like words in URL fragments", () => {
    expect(isAuthUrl("https://example.com/dashboard#/login")).toBe(false);
    expect(isAuthUrl("https://example.com/app#/auth/settings")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isAuthUrl("not-a-url")).toBe(false);
  });
});

// ── DOM detection: login pages ───────────────────────────────────────

describe("detectAuthChallenge - login pages", () => {
  it("detects a generic login page with password input", async () => {
    const page = mockPage("https://example.com/login", {
      type: "login",
      fields: [
        { type: "email", selector: 'input[type="email"]', label: "email" },
        {
          type: "password",
          selector: 'input[type="password"]',
          label: "password",
        },
      ],
    });

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.fields.some((f) => f.type === "password")).toBe(true);
  });

  it("detects Google email step via #identifierId", async () => {
    const page = mockPage("https://accounts.google.com/v3/signin/identifier", {
      type: "login",
      fields: [
        { type: "email", selector: "#identifierId", label: "Google email" },
      ],
    });

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.service).toBe("Google");
    expect(result!.fields[0].selector).toBe("#identifierId");
  });

  it("detects Google password step", async () => {
    const page = mockPage("https://accounts.google.com/v3/signin/challenge", {
      type: "login",
      fields: [
        {
          type: "password",
          selector: 'input[type="password"][name="Passwd"]',
          label: "Google password",
        },
      ],
    });

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.service).toBe("Google");
  });

  it("falls back to URL-only detection when DOM has no auth elements", async () => {
    const page = mockPage("https://accounts.google.com/ServiceLogin", null);

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.service).toBe("Google");
    expect(result!.fields).toEqual([]);
  });
});

// ── DOM detection: 2FA pages ─────────────────────────────────────────

describe("detectAuthChallenge - 2FA pages", () => {
  it("detects a 2FA page with code input", async () => {
    const page = mockPage("https://accounts.google.com/signin/v2/challenge", {
      type: "2fa",
      fields: [
        {
          type: "code",
          selector: 'input[name="code"]',
          label: "verification code",
        },
      ],
    });

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("2fa");
    expect(result!.fields.some((f) => f.type === "code")).toBe(true);
  });

  it("detects 2FA via text patterns even without specific input", async () => {
    const page = mockPage("https://example.com/verify", {
      type: "2fa",
      fields: [
        {
          type: "code",
          selector: "",
          label: "verification code (text detected)",
        },
      ],
    });

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("2fa");
  });
});

// ── DOM detection: OAuth consent ─────────────────────────────────────

describe("detectAuthChallenge - OAuth consent", () => {
  it("detects an OAuth consent page with Allow button", async () => {
    const page = mockPage("https://accounts.google.com/o/oauth2/v2/auth", {
      type: "oauth_consent",
      fields: [
        {
          type: "approval",
          selector: "#submit_approve_access",
          label: "Allow",
        },
      ],
    });

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("oauth_consent");
    expect(result!.service).toBe("Google");
    expect(result!.fields.some((f) => f.type === "approval")).toBe(true);
  });

  it("detects consent with Approve button", async () => {
    const page = mockPage("https://github.com/login/oauth/authorize", {
      type: "oauth_consent",
      fields: [{ type: "approval", selector: "button", label: "Approve" }],
    });

    const result = await detectAuthChallenge(page);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("oauth_consent");
  });
});

// ── Non-auth pages ───────────────────────────────────────────────────

describe("detectAuthChallenge - non-auth pages", () => {
  it("returns null for a regular page", async () => {
    const page = mockPage("https://example.com/dashboard", null);

    const result = await detectAuthChallenge(page);
    expect(result).toBeNull();
  });

  it("returns null for a regular github.com page with no auth elements", async () => {
    const page = mockPage(
      "https://github.com/vellum-ai/vellum-assistant",
      null,
    );

    const result = await detectAuthChallenge(page);
    expect(result).toBeNull();
  });

  it("returns null for a regular page with no auth elements", async () => {
    const page = mockPage("https://news.ycombinator.com/", null);

    const result = await detectAuthChallenge(page);
    expect(result).toBeNull();
  });

  it("returns null when page.evaluate throws", async () => {
    const page = mockPage("https://example.com/login", null);
    page.evaluate = async () => {
      throw new Error("page closed");
    };

    const result = await detectAuthChallenge(page);
    expect(result).toBeNull();
  });
});

// ── formatAuthChallenge ──────────────────────────────────────────────

describe("formatAuthChallenge", () => {
  it("formats a login challenge with service name", () => {
    const challenge: AuthChallenge = {
      type: "login",
      service: "Google",
      fields: [
        { type: "email", selector: "#identifierId", label: "email" },
        {
          type: "password",
          selector: 'input[type="password"]',
          label: "password",
        },
      ],
      url: "https://accounts.google.com/signin",
    };
    const output = formatAuthChallenge(challenge);
    expect(output).toContain("Auth challenge detected: Google login page");
    expect(output).toContain("Type: login");
    expect(output).toContain("Fields: email (email), password (password)");
  });

  it("formats a 2FA challenge", () => {
    const challenge: AuthChallenge = {
      type: "2fa",
      fields: [
        {
          type: "code",
          selector: 'input[name="code"]',
          label: "verification code",
        },
      ],
      url: "https://example.com/verify",
    };
    const output = formatAuthChallenge(challenge);
    expect(output).toContain("Auth challenge detected: 2FA verification");
    expect(output).toContain("Type: 2fa");
  });

  it("formats an OAuth consent challenge", () => {
    const challenge: AuthChallenge = {
      type: "oauth_consent",
      service: "GitHub",
      fields: [{ type: "approval", selector: "button", label: "Authorize" }],
      url: "https://github.com/login/oauth/authorize",
    };
    const output = formatAuthChallenge(challenge);
    expect(output).toContain(
      "Auth challenge detected: GitHub OAuth consent screen",
    );
    expect(output).toContain("Type: oauth_consent");
  });

  it("omits Fields line when there are no fields", () => {
    const challenge: AuthChallenge = {
      type: "login",
      service: "Google",
      fields: [],
      url: "https://accounts.google.com/signin",
    };
    const output = formatAuthChallenge(challenge);
    expect(output).not.toContain("Fields:");
  });
});
