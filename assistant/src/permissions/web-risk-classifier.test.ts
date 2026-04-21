import { describe, expect, test } from "bun:test";

import { WebRiskClassifier } from "./web-risk-classifier.js";

// ── Helper ───────────────────────────────────────────────────────────────────

function makeClassifier(): WebRiskClassifier {
  return new WebRiskClassifier();
}

// ── web_search ───────────────────────────────────────────────────────────────

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

// ── web_fetch ────────────────────────────────────────────────────────────────

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

// ── network_request ──────────────────────────────────────────────────────────

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

// ── Allowlist options ────────────────────────────────────────────────────────

describe("allowlistOptions", () => {
  test("web_fetch with URL produces exact + origin + wildcard options", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com/api/data?key=value",
    });
    const opts = result.allowlistOptions!;
    expect(opts).toBeDefined();
    expect(opts.length).toBe(3);

    // Exact URL
    expect(opts[0].description).toBe("This exact URL");
    expect(opts[0].label).toBe("https://example.com/api/data?key=value");

    // Origin wildcard
    expect(opts[1].description).toBe("Any page on example.com");
    expect(opts[1].label).toBe("https://example.com/*");

    // All fetches
    expect(opts[2].description).toBe("All URL fetches");
    expect(opts[2].label).toBe("web_fetch:*");
    expect(opts[2].pattern).toBe("**");
  });

  test("network_request with URL produces exact + origin + wildcard options", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "network_request",
      url: "https://api.example.com/v1/users",
    });
    const opts = result.allowlistOptions!;
    expect(opts).toBeDefined();
    expect(opts.length).toBe(3);
    expect(opts[0].description).toBe("This exact URL");
    expect(opts[1].description).toBe("Any page on api.example.com");
    expect(opts[2].description).toBe("All network requests");
  });

  test("web_search with no URL produces empty allowlistOptions", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_search",
    });
    expect(result.allowlistOptions).toEqual([]);
  });

  test("web_fetch with no URL produces empty allowlistOptions", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
    });
    expect(result.allowlistOptions).toEqual([]);
  });

  test("deduplicates identical patterns", async () => {
    const classifier = makeClassifier();
    const result = await classifier.classify({
      toolName: "web_fetch",
      url: "https://example.com/",
    });
    const opts = result.allowlistOptions!;
    const patterns = opts.map((o) => o.pattern);
    const uniquePatterns = new Set(patterns);
    expect(patterns.length).toBe(uniquePatterns.size);
  });
});

// ── Singleton ────────────────────────────────────────────────────────────────

describe("singleton", () => {
  test("webRiskClassifier is exported and functional", async () => {
    const { webRiskClassifier } = await import("./web-risk-classifier.js");
    const result = await webRiskClassifier.classify({
      toolName: "web_search",
    });
    expect(result.riskLevel).toBe("low");
  });
});
