import { describe, expect, test } from "bun:test";

import {
  buildProviderRedirectFields,
  readAttributionParams,
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
