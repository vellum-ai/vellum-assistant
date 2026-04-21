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
