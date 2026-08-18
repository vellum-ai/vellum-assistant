import { describe, expect, test } from "bun:test";

import { WebRiskClassifier } from "./web-risk-classifier.js";

// -- Helper -------------------------------------------------------------------

function makeClassifier(): WebRiskClassifier {
  return new WebRiskClassifier();
}

// -- web_search ---------------------------------------------------------------

describe("web_search", () => {
  test("always classified as low risk", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_search",
    });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Web search (read-only)");
    expect(result.matchType).toBe("registry");
    expect(result.scopeOptions).toEqual([]);
  });

  test("low risk even with url provided", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_search",
      url: "https://example.com",
    });
    expect(result.riskLevel).toBe("low");
  });
});

// -- web_fetch ----------------------------------------------------------------

describe("web_fetch", () => {
  test("default (no private network) is low risk", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
    });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Web fetch (default)");
    expect(result.matchType).toBe("registry");
    expect(result.scopeOptions).toEqual([]);
  });

  test("allowPrivateNetwork=false is low risk", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      allowPrivateNetwork: false,
    });
    expect(result.riskLevel).toBe("low");
    expect(result.reason).toBe("Web fetch (default)");
  });

  test("allowPrivateNetwork=undefined is low risk", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      allowPrivateNetwork: undefined,
    });
    expect(result.riskLevel).toBe("low");
  });

  test("allowPrivateNetwork=true is high risk", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      allowPrivateNetwork: true,
    });
    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("Private network fetch");
    expect(result.matchType).toBe("registry");
    expect(result.scopeOptions).toEqual([]);
  });

  test("private network fetch with url", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "http://192.168.1.1/admin",
      allowPrivateNetwork: true,
    });
    expect(result.riskLevel).toBe("high");
    expect(result.reason).toBe("Private network fetch");
  });
});

// -- network_request ----------------------------------------------------------

describe("network_request", () => {
  test("always classified as medium risk", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "network_request",
    });
    expect(result.riskLevel).toBe("medium");
    expect(result.reason).toBe("Network request (proxied credentials)");
    expect(result.matchType).toBe("registry");
    expect(result.scopeOptions).toEqual([]);
  });

  test("medium risk with url provided", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "network_request",
      url: "https://api.example.com/data",
    });
    expect(result.riskLevel).toBe("medium");
  });

  test("medium risk regardless of allowPrivateNetwork flag", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "network_request",
      allowPrivateNetwork: true,
    });
    expect(result.riskLevel).toBe("medium");
    expect(result.reason).toBe("Network request (proxied credentials)");
  });
});

// -- Allowlist options --------------------------------------------------------
// The ladder a saved trust rule is built from, canonicalized through
// `@vellumai/service-contracts/url-normalization` so the saved pattern has one
// spelling rather than whichever the model wrote. Rule lookup is a raw
// exact-string match, so it does not fold those spellings together.

describe("allowlistOptions", () => {
  test("web_fetch offers the exact URL, the origin, then the tool", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com/docs/page",
    });
    expect(result.allowlistOptions).toEqual([
      {
        label: "https://example.com/docs/page",
        description: "This exact URL",
        pattern: "web_fetch:https://example.com/docs/page",
      },
      {
        label: "https://example.com/*",
        description: "Any page on example.com",
        pattern: "web_fetch:https://example.com/*",
      },
      {
        label: "web_fetch:*",
        description: "All URL fetches",
        // A standalone globstar: `web_fetch:*` would not match a candidate
        // containing "/". The tool field is matched separately.
        pattern: "**",
      },
    ]);
  });

  test("network_request offers the same ladder under its own tool name", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "network_request",
      url: "https://api.example.com/v1/users",
    });
    expect(result.allowlistOptions?.map((o) => o.pattern)).toEqual([
      "network_request:https://api.example.com/v1/users",
      "network_request:https://api.example.com/*",
      "**",
    ]);
  });

  test("the URL is canonicalized, so a rule saved here matches the next call", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      // Userinfo and fragment must never reach a saved rule; a trailing root
      // dot and a percent-escaped path segment are the same target.
      url: "https://user:pw@EXAMPLE.com./%70rivate/page#section",
    });
    expect(result.allowlistOptions?.[0].pattern).toBe(
      "web_fetch:https://example.com/private/page",
    );
    expect(result.allowlistOptions?.[1].pattern).toBe(
      "web_fetch:https://example.com/*",
    );
  });

  test("host:port shorthand resolves to an https origin", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "example.com:8443/status",
    });
    expect(result.allowlistOptions?.[1].pattern).toBe(
      "web_fetch:https://example.com:8443/*",
    );
  });

  test("a non-http target offers no origin option", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "file:///etc/passwd",
    });
    // The raw text is still offered as an exact literal, but nothing that
    // would grant a scheme-wide or origin-wide rule.
    expect(result.allowlistOptions?.map((o) => o.pattern)).toEqual([
      "web_fetch:file:///etc/passwd",
      "**",
    ]);
  });

  test("a URL carrying glob-looking characters is offered verbatim", async () => {
    // Rules are matched by exact string, so a pattern that escapes anything
    // the lookup key does not escape is a rule that can never fire.
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com/a(b)+c[d]",
    });
    expect(result.allowlistOptions?.[0].pattern).toBe(
      "web_fetch:https://example.com/a(b)+c[d]",
    );
  });

  test("web_search carries no ladder: it has no URL to scope a rule to", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_search",
    });
    expect(result.allowlistOptions).toBeUndefined();
  });
});

// -- Singleton ----------------------------------------------------------------

describe("singleton", () => {
  test("webRiskClassifier is exported and functional", async () => {
    const { webRiskClassifier } = await import("./web-risk-classifier.js");
    const result = await webRiskClassifier.classify({
      toolName: "web_search",
    });
    expect(result.riskLevel).toBe("low");
  });
});
