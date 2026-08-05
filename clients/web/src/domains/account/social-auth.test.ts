import { describe, expect, test } from "bun:test";

import {
  buildProviderRedirectFields,
  readAttributionParams,
  withPreservedAttribution,
} from "@/domains/account/social-auth";

const ORIGIN = "https://www.vellum.ai";
const CALLBACK = "/account/provider/callback";

function fields(attribution?: Record<string, string>) {
  return buildProviderRedirectFields("workos", CALLBACK, ORIGIN, {
    intent: "signup",
    ...(attribution ? { attribution } : {}),
  });
}

describe("readAttributionParams", () => {
  test("collects the params a paid-social landing carries", () => {
    const collected = readAttributionParams(
      "?utm_source=ig&utm_medium=paid-social&utm_campaign=personal-ai&fbclid=abc123",
    );

    expect(collected).toEqual({
      utm_source: "ig",
      utm_medium: "paid-social",
      utm_campaign: "personal-ai",
      fbclid: "abc123",
    });
  });

  test("collects nothing for an organic arrival", () => {
    expect(readAttributionParams("?returnTo=%2Fassistant")).toEqual({});
  });

  test("bounds an oversized value", () => {
    const collected = readAttributionParams(`?fbclid=${"x".repeat(5000)}`);

    expect(collected["fbclid"]).toHaveLength(512);
  });
});

describe("withPreservedAttribution", () => {
  test("appends attribution after an existing returnTo", () => {
    const href = withPreservedAttribution(
      "/account/signup?returnTo=%2Fassistant",
      "?utm_source=ig&fbclid=abc123",
    );

    expect(href).toBe(
      "/account/signup?returnTo=%2Fassistant&utm_source=ig&fbclid=abc123",
    );
  });

  test("starts the query string on a bare route", () => {
    expect(withPreservedAttribution("/account/signup", "?utm_source=ig")).toBe(
      "/account/signup?utm_source=ig",
    );
  });

  test("leaves the href untouched for an organic arrival", () => {
    expect(
      withPreservedAttribution(
        "/account/signup?returnTo=%2Fassistant",
        "?returnTo=%2Fassistant",
      ),
    ).toBe("/account/signup?returnTo=%2Fassistant");
    expect(withPreservedAttribution("/account/signup", "")).toBe(
      "/account/signup",
    );
  });

  test("does not carry non-allowlisted params", () => {
    expect(
      withPreservedAttribution("/account/signup", "?debug=1&utm_source=ig"),
    ).toBe("/account/signup?utm_source=ig");
  });

  test("keeps the href's existing value on a conflicting key", () => {
    expect(
      withPreservedAttribution("/account/signup?utm_source=x", "?utm_source=y"),
    ).toBe("/account/signup?utm_source=x");
  });

  test("appends only the keys the href does not already carry", () => {
    expect(
      withPreservedAttribution(
        "/account/signup?utm_source=x",
        "?utm_source=y&fbclid=abc123",
      ),
    ).toBe("/account/signup?utm_source=x&fbclid=abc123");
  });

  test("is idempotent when re-applied with the same search", () => {
    const search = "?utm_source=ig&fbclid=abc123";
    const once = withPreservedAttribution(
      "/account/signup?returnTo=%2Fassistant",
      search,
    );

    expect(withPreservedAttribution(once, search)).toBe(once);
  });
});

describe("buildProviderRedirectFields", () => {
  test("forwards attribution so the backend can read it without the cookie", () => {
    const built = fields({ utm_source: "ig", fbclid: "abc123" });

    expect(built["utm_source"]).toBe("ig");
    expect(built["fbclid"]).toBe("abc123");
  });

  test("keeps the existing fields intact", () => {
    const built = fields({ utm_source: "ig" });

    expect(built["provider"]).toBe("workos");
    expect(built["callback_url"]).toBe(`${ORIGIN}${CALLBACK}`);
    expect(built["process"]).toBe("login");
    expect(built["intent"]).toBe("signup");
  });

  test("omits attribution keys entirely when there are none", () => {
    const built = fields();

    expect(built["utm_source"]).toBeUndefined();
    expect(built["fbclid"]).toBeUndefined();
  });

  test("a crafted landing URL cannot redirect the flow elsewhere", () => {
    const built = fields({
      provider: "evil",
      callback_url: "https://evil.example/steal",
      process: "connect",
      utm_source: "ig",
    } as Record<string, string>);

    // Only allowlisted attribution keys are copied; the reserved fields keep
    // the values the caller set.
    expect(built["provider"]).toBe("workos");
    expect(built["callback_url"]).toBe(`${ORIGIN}${CALLBACK}`);
    expect(built["process"]).toBe("login");
    expect(built["utm_source"]).toBe("ig");
  });
});
