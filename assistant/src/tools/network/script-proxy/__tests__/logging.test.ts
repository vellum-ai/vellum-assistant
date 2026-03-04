import { describe, expect, test } from "bun:test";

import type { PolicyDecision } from "../../../../outbound-proxy/index.js";
import {
  buildCredentialRefTrace,
  buildDecisionTrace,
  createSafeLogEntry,
  sanitizeHeaders,
  sanitizeUrl,
  stripQueryString,
} from "../../../../outbound-proxy/index.js";
import type { CredentialInjectionTemplate } from "../../../credentials/policy-types.js";

// ---------------------------------------------------------------------------
// sanitizeHeaders
// ---------------------------------------------------------------------------

describe("sanitizeHeaders", () => {
  test("redacts sensitive keys", () => {
    const headers = {
      Authorization: "secret-value",
      "Content-Type": "application/json",
      "X-API-Key": "another-secret",
    };
    const result = sanitizeHeaders(headers, ["authorization", "x-api-key"]);
    expect(result["Authorization"]).toBe("[REDACTED]");
    expect(result["Content-Type"]).toBe("application/json");
    expect(result["X-API-Key"]).toBe("[REDACTED]");
  });

  test("case-insensitive matching", () => {
    const headers = { authorization: "bearer xyz" };
    const result = sanitizeHeaders(headers, ["Authorization"]);
    expect(result["authorization"]).toBe("[REDACTED]");
  });

  test("preserves non-sensitive headers", () => {
    const headers = { Accept: "text/html", Host: "example.com" };
    const result = sanitizeHeaders(headers, ["authorization"]);
    expect(result).toEqual(headers);
  });

  test("handles empty headers", () => {
    const result = sanitizeHeaders({}, ["authorization"]);
    expect(result).toEqual({});
  });

  test("handles empty sensitive keys", () => {
    const headers = { Authorization: "bearer xyz" };
    const result = sanitizeHeaders(headers, []);
    expect(result["Authorization"]).toBe("bearer xyz");
  });
});

// ---------------------------------------------------------------------------
// sanitizeUrl
// ---------------------------------------------------------------------------

describe("sanitizeUrl", () => {
  test("redacts sensitive query params from absolute URL", () => {
    const result = sanitizeUrl(
      "https://api.example.com/v1?api_key=secret123&format=json",
      ["api_key"],
    );
    expect(result).toContain("api_key=%5BREDACTED%5D");
    expect(result).toContain("format=json");
    expect(result).not.toContain("secret123");
  });

  test("redacts sensitive query params from relative path", () => {
    const result = sanitizeUrl("/v1/search?token=abc&q=hello", ["token"]);
    expect(result).toContain("token=%5BREDACTED%5D");
    expect(result).toContain("q=hello");
    expect(result).not.toContain("abc");
  });

  test("returns URL unchanged when no sensitive params", () => {
    const url = "https://api.example.com/v1?format=json";
    expect(sanitizeUrl(url, ["api_key"])).toBe(url);
  });

  test("returns URL unchanged when sensitiveParams is empty", () => {
    const url = "https://api.example.com/v1?api_key=secret";
    expect(sanitizeUrl(url, [])).toBe(url);
  });

  test("returns URL unchanged when no query string", () => {
    expect(sanitizeUrl("https://api.example.com/v1", ["api_key"])).toBe(
      "https://api.example.com/v1",
    );
  });

  test("case-insensitive param matching", () => {
    const result = sanitizeUrl("https://api.example.com/v1?API_KEY=secret", [
      "api_key",
    ]);
    expect(result).not.toContain("secret");
  });

  test("strips query string entirely for unparseable URLs", () => {
    // Malformed URL that URL constructor can't parse
    const result = sanitizeUrl("http://[invalid:url?key=secret", ["key"]);
    expect(result).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// createSafeLogEntry
// ---------------------------------------------------------------------------

describe("createSafeLogEntry", () => {
  test("sanitizes both URL and headers", () => {
    const req = {
      method: "GET",
      url: "/api?token=secret",
      headers: { Authorization: "Bearer xyz", Accept: "application/json" },
    };
    const result = createSafeLogEntry(req, ["authorization", "token"]);
    expect(result.method).toBe("GET");
    expect(result.url).not.toContain("secret");
    expect(result.headers["Authorization"]).toBe("[REDACTED]");
    expect(result.headers["Accept"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// stripQueryString
// ---------------------------------------------------------------------------

describe("stripQueryString", () => {
  test("strips query from path", () => {
    expect(stripQueryString("/api/v1?key=value")).toBe("/api/v1");
  });

  test("returns path unchanged when no query", () => {
    expect(stripQueryString("/api/v1")).toBe("/api/v1");
  });

  test("handles empty path", () => {
    expect(stripQueryString("")).toBe("");
  });

  test("handles query-only", () => {
    expect(stripQueryString("?key=value")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildDecisionTrace
// ---------------------------------------------------------------------------

describe("buildDecisionTrace", () => {
  test("matched decision", () => {
    const decision: PolicyDecision = {
      kind: "matched",
      credentialId: "cred-1",
      template: {
        hostPattern: "*.example.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    };
    const trace = buildDecisionTrace(
      "api.example.com",
      443,
      "/api?key=secret",
      "https",
      decision,
    );
    expect(trace.host).toBe("api.example.com");
    expect(trace.port).toBe(443);
    expect(trace.path).toBe("/api");
    expect(trace.scheme).toBe("https");
    expect(trace.decisionKind).toBe("matched");
    expect(trace.candidateCount).toBe(1);
    expect(trace.selectedPattern).toBe("*.example.com");
    expect(trace.selectedCredentialId).toBe("cred-1");
  });

  test("ambiguous decision", () => {
    const decision: PolicyDecision = {
      kind: "ambiguous",
      candidates: [
        {
          credentialId: "cred-1",
          template: {
            hostPattern: "*.example.com",
            injectionType: "header",
          } as CredentialInjectionTemplate,
        },
        {
          credentialId: "cred-2",
          template: {
            hostPattern: "*.example.com",
            injectionType: "header",
          } as CredentialInjectionTemplate,
        },
      ],
    };
    const trace = buildDecisionTrace(
      "api.example.com",
      null,
      "/",
      "https",
      decision,
    );
    expect(trace.decisionKind).toBe("ambiguous");
    expect(trace.candidateCount).toBe(2);
    expect(trace.selectedPattern).toBeNull();
    expect(trace.selectedCredentialId).toBeNull();
  });

  test("missing decision", () => {
    const decision: PolicyDecision = { kind: "missing" };
    const trace = buildDecisionTrace(
      "unknown.com",
      null,
      "/",
      "https",
      decision,
    );
    expect(trace.decisionKind).toBe("missing");
    expect(trace.candidateCount).toBe(0);
  });

  test("unauthenticated decision", () => {
    const decision: PolicyDecision = { kind: "unauthenticated" };
    const trace = buildDecisionTrace(
      "example.com",
      null,
      "/",
      "http",
      decision,
    );
    expect(trace.decisionKind).toBe("unauthenticated");
    expect(trace.candidateCount).toBe(0);
  });

  test("ask_missing_credential decision", () => {
    const decision: PolicyDecision = {
      kind: "ask_missing_credential",
      target: {
        hostname: "api.example.com",
        port: null,
        path: "/",
        scheme: "https",
      },
      matchingPatterns: ["*.example.com", "api.example.com"],
    };
    const trace = buildDecisionTrace(
      "api.example.com",
      null,
      "/",
      "https",
      decision,
    );
    expect(trace.decisionKind).toBe("ask_missing_credential");
    expect(trace.candidateCount).toBe(2);
  });

  test("ask_unauthenticated decision", () => {
    const decision: PolicyDecision = {
      kind: "ask_unauthenticated",
      target: {
        hostname: "unknown.com",
        port: null,
        path: "/",
        scheme: "https",
      },
    };
    const trace = buildDecisionTrace(
      "unknown.com",
      null,
      "/",
      "https",
      decision,
    );
    expect(trace.decisionKind).toBe("ask_unauthenticated");
    expect(trace.candidateCount).toBe(0);
  });

  test("strips query string from path to avoid leaking secrets", () => {
    const decision: PolicyDecision = { kind: "unauthenticated" };
    const trace = buildDecisionTrace(
      "example.com",
      null,
      "/api?secret=abc",
      "https",
      decision,
    );
    expect(trace.path).toBe("/api");
    expect(trace.path).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// buildCredentialRefTrace
// ---------------------------------------------------------------------------

describe("buildCredentialRefTrace", () => {
  test("builds trace with all fields", () => {
    const trace = buildCredentialRefTrace(
      ["my-api-key", "unknown-ref"],
      ["uuid-1"],
      ["unknown-ref"],
    );
    expect(trace.rawRefs).toEqual(["my-api-key", "unknown-ref"]);
    expect(trace.resolvedIds).toEqual(["uuid-1"]);
    expect(trace.unresolvedRefs).toEqual(["unknown-ref"]);
  });

  test("handles empty arrays", () => {
    const trace = buildCredentialRefTrace([], [], []);
    expect(trace.rawRefs).toEqual([]);
    expect(trace.resolvedIds).toEqual([]);
    expect(trace.unresolvedRefs).toEqual([]);
  });
});
