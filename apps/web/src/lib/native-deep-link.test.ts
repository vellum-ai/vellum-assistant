import { describe, expect, test } from "bun:test";

import {
  buildOAuthCompleteDeepLink,
  getNativeUrlSchemeForHost,
  parseOAuthCompleteDeepLink,
} from "@/lib/native-deep-link.js";

describe("getNativeUrlSchemeForHost", () => {
  test("maps prod hostname to vellum-assistant", () => {
    expect(getNativeUrlSchemeForHost("www.vellum.ai")).toBe("vellum-assistant");
    expect(getNativeUrlSchemeForHost("vellum.ai")).toBe("vellum-assistant");
  });

  test("maps staging hostname to vellum-assistant-staging", () => {
    expect(getNativeUrlSchemeForHost("staging-assistant.vellum.ai")).toBe(
      "vellum-assistant-staging",
    );
  });

  test("maps dev hostname to vellum-assistant-dev", () => {
    expect(getNativeUrlSchemeForHost("dev-assistant.vellum.ai")).toBe(
      "vellum-assistant-dev",
    );
  });

  test("returns null for unknown hostnames", () => {
    expect(getNativeUrlSchemeForHost("evil.example.com")).toBeNull();
    expect(getNativeUrlSchemeForHost("localhost:3000")).toBeNull();
    expect(getNativeUrlSchemeForHost("")).toBeNull();
  });
});

describe("buildOAuthCompleteDeepLink", () => {
  test("builds canonical URL with all params", () => {
    const url = buildOAuthCompleteDeepLink("vellum-assistant", {
      requestId: "req-123",
      oauthStatus: "connected",
      oauthProvider: "linear",
      oauthCode: null,
    });
    expect(url).toBe(
      "vellum-assistant://oauth-complete?requestId=req-123&oauth_status=connected&oauth_provider=linear",
    );
  });

  test("omits null params", () => {
    const url = buildOAuthCompleteDeepLink("vellum-assistant-dev", {
      requestId: "req-456",
      oauthStatus: null,
      oauthProvider: null,
      oauthCode: null,
    });
    expect(url).toBe("vellum-assistant-dev://oauth-complete?requestId=req-456");
  });

  test("includes oauth_code when present", () => {
    const url = buildOAuthCompleteDeepLink("vellum-assistant", {
      requestId: "req-789",
      oauthStatus: "error",
      oauthProvider: "linear",
      oauthCode: "access_denied",
    });
    expect(url).toContain("oauth_code=access_denied");
    expect(url).toContain("oauth_status=error");
  });

  test("URL-encodes special characters in params", () => {
    const url = buildOAuthCompleteDeepLink("vellum-assistant", {
      requestId: "req with spaces",
      oauthStatus: "error",
      oauthProvider: null,
      oauthCode: "needs encoding & more",
    });
    expect(url).toContain("requestId=req+with+spaces");
    expect(url).toContain("oauth_code=needs+encoding+%26+more");
  });
});

describe("parseOAuthCompleteDeepLink", () => {
  test("parses a canonical OAuth-complete deep link", () => {
    const payload = parseOAuthCompleteDeepLink(
      "vellum-assistant://oauth-complete?requestId=req-123&oauth_status=connected&oauth_provider=linear",
    );
    expect(payload).toEqual({
      requestId: "req-123",
      oauthStatus: "connected",
      oauthProvider: "linear",
      oauthCode: null,
    });
  });

  test("accepts the staging scheme", () => {
    const payload = parseOAuthCompleteDeepLink(
      "vellum-assistant-staging://oauth-complete?requestId=req-456&oauth_status=connected",
    );
    expect(payload?.requestId).toBe("req-456");
  });

  test("accepts the dev scheme", () => {
    const payload = parseOAuthCompleteDeepLink(
      "vellum-assistant-dev://oauth-complete?requestId=req-789",
    );
    expect(payload?.requestId).toBe("req-789");
  });

  test("rejects URLs with foreign schemes", () => {
    expect(
      parseOAuthCompleteDeepLink(
        "https://oauth-complete?requestId=req-123",
      ),
    ).toBeNull();
    expect(
      parseOAuthCompleteDeepLink("evil://oauth-complete?requestId=req-123"),
    ).toBeNull();
    expect(
      parseOAuthCompleteDeepLink(
        "vellum-something-else://oauth-complete?requestId=req-123",
      ),
    ).toBeNull();
  });

  test("rejects schemes that share the `vellum-assistant` prefix but are not on the allow-list", () => {
    // A malicious app could register `vellum-assistant-evil://` on the device.
    // The exact-match allow-list is the cheapest line of defence against
    // routing such a deep link into our OAuth completion path.
    expect(
      parseOAuthCompleteDeepLink(
        "vellum-assistant-evil://oauth-complete?requestId=spoofed",
      ),
    ).toBeNull();
    expect(
      parseOAuthCompleteDeepLink(
        "vellum-assistantx://oauth-complete?requestId=spoofed",
      ),
    ).toBeNull();
    expect(
      parseOAuthCompleteDeepLink(
        "vellum-assistant-foo://oauth-complete?requestId=spoofed",
      ),
    ).toBeNull();
  });

  test("rejects URLs with the right scheme but wrong host", () => {
    expect(
      parseOAuthCompleteDeepLink(
        "vellum-assistant://login?requestId=req-123",
      ),
    ).toBeNull();
    expect(
      parseOAuthCompleteDeepLink(
        "vellum-assistant://something/oauth-complete?requestId=req-123",
      ),
    ).toBeNull();
  });

  test("rejects URLs missing requestId", () => {
    expect(
      parseOAuthCompleteDeepLink(
        "vellum-assistant://oauth-complete?oauth_status=connected",
      ),
    ).toBeNull();
    expect(
      parseOAuthCompleteDeepLink("vellum-assistant://oauth-complete"),
    ).toBeNull();
  });

  test("rejects malformed URLs", () => {
    expect(parseOAuthCompleteDeepLink("not a url")).toBeNull();
    expect(parseOAuthCompleteDeepLink("")).toBeNull();
  });

  test("preserves null oauth_code when absent", () => {
    const payload = parseOAuthCompleteDeepLink(
      "vellum-assistant://oauth-complete?requestId=req-123&oauth_status=connected",
    );
    expect(payload?.oauthCode).toBeNull();
  });

  test("captures oauth_code when present", () => {
    const payload = parseOAuthCompleteDeepLink(
      "vellum-assistant://oauth-complete?requestId=req-123&oauth_status=error&oauth_code=access_denied",
    );
    expect(payload?.oauthStatus).toBe("error");
    expect(payload?.oauthCode).toBe("access_denied");
  });

  test("round-trips with buildOAuthCompleteDeepLink", () => {
    const original = {
      requestId: "round-trip-id",
      oauthStatus: "connected",
      oauthProvider: "linear",
      oauthCode: null,
    };
    const url = buildOAuthCompleteDeepLink("vellum-assistant", original);
    expect(parseOAuthCompleteDeepLink(url)).toEqual(original);
  });

  test("round-trips empty-string fields without dropping them", () => {
    // Truthiness checks on `oauthStatus` etc. would silently drop empty
    // strings — keep the build/parse pair lossless instead.
    const original = {
      requestId: "round-trip-id",
      oauthStatus: "",
      oauthProvider: "",
      oauthCode: "",
    };
    const url = buildOAuthCompleteDeepLink("vellum-assistant", original);
    expect(parseOAuthCompleteDeepLink(url)).toEqual(original);
  });
});
