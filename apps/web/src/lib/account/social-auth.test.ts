import { describe, expect, test } from "bun:test";

import type { Flow } from "@/generated/auth/types.gen.js";
import { routes } from "@/lib/routes.js";

import {
  assertCsrfToken,
  buildProviderRedirectFields,
  classifyCallbackFlows,
  PROVIDER_REDIRECT_PATH,
  SOCIAL_PROVIDERS,
} from "@/lib/account/social-auth.js";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

describe("SOCIAL_PROVIDERS", () => {
  test("includes workos-oidc", () => {
    expect(SOCIAL_PROVIDERS.some((p) => p.id === "workos-oidc")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_REDIRECT_PATH
// ---------------------------------------------------------------------------

describe("PROVIDER_REDIRECT_PATH", () => {
  test("points at the backend provider-redirect view", () => {
    expect(PROVIDER_REDIRECT_PATH).toBe("/accounts/oidc/redirect/");
  });
});

// ---------------------------------------------------------------------------
// buildProviderRedirectFields
// ---------------------------------------------------------------------------

describe("buildProviderRedirectFields", () => {
  const origin = "https://app.example.com";

  test("returns base fields without intent by default", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
    );

    expect(fields).toEqual({
      provider: "workos-oidc",
      callback_url: `https://app.example.com${routes.account.providerCallback}`,
      process: "login",
    });
    expect(fields).not.toHaveProperty("intent");
    expect(fields).not.toHaveProperty("login_hint");
    expect(fields).not.toHaveProperty("provider_hint");
  });

  test("includes intent=signup when intent is 'signup'", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
      { intent: "signup" },
    );

    expect(fields.intent).toBe("signup");
    expect(fields.provider).toBe("workos-oidc");
    expect(fields.process).toBe("login");
  });

  test("includes intent=login when intent is 'login'", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
      { intent: "login" },
    );

    expect(fields.intent).toBe("login");
  });

  test("resolves relative callback_url against origin", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      "/cb",
      "https://other.example.com",
    );

    expect(fields.callback_url).toBe("https://other.example.com/cb");
  });

  test("includes login_hint when loginHint is provided", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
      { loginHint: "user@example.com" },
    );

    expect(fields.login_hint).toBe("user@example.com");
  });

  test("omits login_hint when loginHint is an empty string", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
      { loginHint: "" },
    );

    expect(fields).not.toHaveProperty("login_hint");
  });

  test("includes provider_hint when providerHint is provided", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
      { providerHint: "GoogleOAuth" },
    );

    expect(fields.provider_hint).toBe("GoogleOAuth");
  });

  test("omits provider_hint when providerHint is an empty string", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
      { providerHint: "" },
    );

    expect(fields).not.toHaveProperty("provider_hint");
  });

  test("includes all three fields when all options are provided", () => {
    const fields = buildProviderRedirectFields(
      "workos-oidc",
      routes.account.providerCallback,
      origin,
      {
        intent: "signup",
        loginHint: "user@example.com",
        providerHint: "GoogleOAuth",
      },
    );

    expect(fields.intent).toBe("signup");
    expect(fields.login_hint).toBe("user@example.com");
    expect(fields.provider_hint).toBe("GoogleOAuth");
    expect(fields.provider).toBe("workos-oidc");
    expect(fields.process).toBe("login");
  });
});

// ---------------------------------------------------------------------------
// assertCsrfToken
// ---------------------------------------------------------------------------

describe("assertCsrfToken", () => {
  test("throws a descriptive error when token is null", () => {
    expect(() => assertCsrfToken(null)).toThrow(/CSRF token is missing/);
  });

  test("throws a descriptive error when token is undefined", () => {
    expect(() => assertCsrfToken(undefined)).toThrow(/CSRF token is missing/);
  });

  test("throws a descriptive error when token is an empty string", () => {
    expect(() => assertCsrfToken("")).toThrow(/CSRF token is missing/);
  });

  test("does not throw when a non-empty token is present", () => {
    expect(() => assertCsrfToken("some-token")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// classifyCallbackFlows
// ---------------------------------------------------------------------------

describe("classifyCallbackFlows", () => {
  test("returns authenticated when user is authenticated", () => {
    const result = classifyCallbackFlows(true, []);
    expect(result).toEqual({ kind: "authenticated" });
  });

  test("returns provider_signup when pending provider_signup flow exists", () => {
    const flows: Flow[] = [{ id: "provider_signup", is_pending: true }];
    const result = classifyCallbackFlows(false, flows);
    expect(result).toEqual({ kind: "provider_signup" });
  });

  test("returns authenticated even if pending flows exist", () => {
    const flows: Flow[] = [{ id: "provider_signup", is_pending: true }];
    const result = classifyCallbackFlows(true, flows);
    expect(result).toEqual({ kind: "authenticated" });
  });

  test("returns error for empty pending flows when not authenticated", () => {
    const result = classifyCallbackFlows(false, []);
    expect(result.kind).toBe("error");
  });

  test("returns error when flows exist but none are pending", () => {
    const flows: Flow[] = [{ id: "provider_signup" }];
    const result = classifyCallbackFlows(false, flows);
    expect(result.kind).toBe("error");
  });
});
