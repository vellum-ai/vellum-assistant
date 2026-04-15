import { describe, expect, it } from "bun:test";

import {
  type AuthChallenge,
  detectAuthChallenge,
  detectCaptchaChallenge,
  formatAuthChallenge,
  identifyService,
  isAuthUrl,
} from "../auth-detector.js";
import { CdpError } from "../cdp-client/errors.js";
import type { CdpClient } from "../cdp-client/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Programmable fake CdpClient used in place of a Playwright Page.
 *
 * `urlValue` drives the response to `document.location.href` reads,
 * `domResult` drives the auth-detector DOM IIFE, and `captchaResult`
 * drives the CAPTCHA detector IIFE. Any of these can be replaced with
 * a function to throw for specific call counts.
 */
function fakeCdp(opts: {
  urlValue: string;
  domResult?: unknown;
  captchaResult?: boolean;
  throwOn?: (expression: string) => boolean;
}): CdpClient {
  return {
    async send<T>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      if (method !== "Runtime.evaluate") {
        throw new Error(
          `unexpected CDP method in auth-detector test: ${method}`,
        );
      }
      const expression = String(
        (params as Record<string, unknown>)?.["expression"] ?? "",
      );
      if (opts.throwOn?.(expression)) {
        throw new CdpError("cdp_error", "synthetic failure", {
          cdpMethod: method,
          cdpParams: params,
        });
      }
      if (expression === "document.location.href") {
        return { result: { value: opts.urlValue } } as T;
      }
      // CAPTCHA detector expression starts with "(() => {\n  // Cloudflare"
      if (/just a moment/.test(expression)) {
        return { result: { value: opts.captchaResult === true } } as T;
      }
      // Anything else is treated as the auth-detector DOM IIFE.
      return { result: { value: opts.domResult ?? null } } as T;
    },
    dispose() {},
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
    const cdp = fakeCdp({
      urlValue: "https://example.com/login",
      domResult: {
        type: "login",
        fields: [
          { type: "email", selector: 'input[type="email"]', label: "email" },
          {
            type: "password",
            selector: 'input[type="password"]',
            label: "password",
          },
        ],
      },
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.fields.some((f) => f.type === "password")).toBe(true);
  });

  it("detects Google email step via #identifierId", async () => {
    const cdp = fakeCdp({
      urlValue: "https://accounts.google.com/v3/signin/identifier",
      domResult: {
        type: "login",
        fields: [
          { type: "email", selector: "#identifierId", label: "Google email" },
        ],
      },
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.service).toBe("Google");
    expect(result!.fields[0].selector).toBe("#identifierId");
  });

  it("detects Google password step", async () => {
    const cdp = fakeCdp({
      urlValue: "https://accounts.google.com/v3/signin/challenge",
      domResult: {
        type: "login",
        fields: [
          {
            type: "password",
            selector: 'input[type="password"][name="Passwd"]',
            label: "Google password",
          },
        ],
      },
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.service).toBe("Google");
  });

  it("falls back to URL-only detection when DOM has no auth elements", async () => {
    const cdp = fakeCdp({
      urlValue: "https://accounts.google.com/ServiceLogin",
      domResult: null,
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("login");
    expect(result!.service).toBe("Google");
    expect(result!.fields).toEqual([]);
  });
});

// ── DOM detection: 2FA pages ─────────────────────────────────────────

describe("detectAuthChallenge - 2FA pages", () => {
  it("detects a 2FA page with code input", async () => {
    const cdp = fakeCdp({
      urlValue: "https://accounts.google.com/signin/v2/challenge",
      domResult: {
        type: "2fa",
        fields: [
          {
            type: "code",
            selector: 'input[name="code"]',
            label: "verification code",
          },
        ],
      },
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("2fa");
    expect(result!.fields.some((f) => f.type === "code")).toBe(true);
  });

  it("detects 2FA via text patterns even without specific input", async () => {
    const cdp = fakeCdp({
      urlValue: "https://example.com/verify",
      domResult: {
        type: "2fa",
        fields: [
          {
            type: "code",
            selector: "",
            label: "verification code (text detected)",
          },
        ],
      },
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("2fa");
  });
});

// ── DOM detection: OAuth consent ─────────────────────────────────────

describe("detectAuthChallenge - OAuth consent", () => {
  it("detects an OAuth consent page with Allow button", async () => {
    const cdp = fakeCdp({
      urlValue: "https://accounts.google.com/o/oauth2/v2/auth",
      domResult: {
        type: "oauth_consent",
        fields: [
          {
            type: "approval",
            selector: "#submit_approve_access",
            label: "Allow",
          },
        ],
      },
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("oauth_consent");
    expect(result!.service).toBe("Google");
    expect(result!.fields.some((f) => f.type === "approval")).toBe(true);
  });

  it("detects consent with Approve button", async () => {
    const cdp = fakeCdp({
      urlValue: "https://github.com/login/oauth/authorize",
      domResult: {
        type: "oauth_consent",
        fields: [{ type: "approval", selector: "button", label: "Approve" }],
      },
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("oauth_consent");
  });
});

// ── Non-auth pages ───────────────────────────────────────────────────

describe("detectAuthChallenge - non-auth pages", () => {
  it("returns null for a regular page", async () => {
    const cdp = fakeCdp({
      urlValue: "https://example.com/dashboard",
      domResult: null,
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).toBeNull();
  });

  it("returns null for a regular github.com page with no auth elements", async () => {
    const cdp = fakeCdp({
      urlValue: "https://github.com/vellum-ai/vellum-assistant",
      domResult: null,
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).toBeNull();
  });

  it("returns null for a regular page with no auth elements", async () => {
    const cdp = fakeCdp({
      urlValue: "https://news.ycombinator.com/",
      domResult: null,
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).toBeNull();
  });

  it("returns null when Runtime.evaluate throws a CdpError", async () => {
    const cdp = fakeCdp({
      urlValue: "https://example.com/login",
      domResult: null,
      throwOn: (expr) =>
        !expr.startsWith("document.location.href") &&
        !/just a moment/.test(expr),
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).toBeNull();
  });

  it("returns null when getCurrentUrl throws a CdpError", async () => {
    const cdp = fakeCdp({
      urlValue: "https://example.com/login",
      domResult: null,
      throwOn: (expr) => expr === "document.location.href",
    });

    const result = await detectAuthChallenge(cdp);
    expect(result).toBeNull();
  });
});

// ── CAPTCHA detection ────────────────────────────────────────────────

describe("detectCaptchaChallenge", () => {
  it("returns a captcha AuthChallenge when the IIFE returns true", async () => {
    const cdp = fakeCdp({
      urlValue: "https://example.com/blocked",
      captchaResult: true,
    });

    const result = await detectCaptchaChallenge(cdp);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("captcha");
    expect(result!.url).toBe("https://example.com/blocked");
    expect(result!.fields).toEqual([]);
  });

  it("returns null when the IIFE returns false", async () => {
    const cdp = fakeCdp({
      urlValue: "https://example.com/home",
      captchaResult: false,
    });

    const result = await detectCaptchaChallenge(cdp);
    expect(result).toBeNull();
  });

  it("returns null when Runtime.evaluate throws", async () => {
    const cdp = fakeCdp({
      urlValue: "https://example.com/home",
      captchaResult: true,
      throwOn: (expr) => /just a moment/.test(expr),
    });

    const result = await detectCaptchaChallenge(cdp);
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
