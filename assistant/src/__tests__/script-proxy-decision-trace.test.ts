import { describe, expect, test } from "bun:test";

import {
  buildCredentialRefTrace,
  buildDecisionTrace,
  type CredentialRefTrace,
  type PolicyDecision,
  type ProxyDecisionTrace,
} from "../outbound-proxy/index.js";

describe("buildDecisionTrace", () => {
  test("matched decision includes selected pattern and credential", () => {
    const decision: PolicyDecision = {
      kind: "matched",
      credentialId: "cred-fal",
      template: {
        hostPattern: "*.fal.ai",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Key ",
      },
    };
    const trace = buildDecisionTrace(
      "api.fal.ai",
      443,
      "/v1/run",
      "https",
      decision,
    );
    expect(trace).toEqual<ProxyDecisionTrace>({
      host: "api.fal.ai",
      port: 443,
      path: "/v1/run",
      scheme: "https",
      decisionKind: "matched",
      candidateCount: 1,
      selectedPattern: "*.fal.ai",
      selectedCredentialId: "cred-fal",
    });
  });

  test("ambiguous decision includes candidate count but no selection", () => {
    const decision: PolicyDecision = {
      kind: "ambiguous",
      candidates: [
        {
          credentialId: "cred-a",
          template: {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "Authorization",
          },
        },
        {
          credentialId: "cred-b",
          template: {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "X-Key",
          },
        },
      ],
    };
    const trace = buildDecisionTrace(
      "api.fal.ai",
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

  test("missing decision has zero candidates", () => {
    const decision: PolicyDecision = { kind: "missing" };
    const trace = buildDecisionTrace(
      "unknown.com",
      443,
      "/",
      "https",
      decision,
    );
    expect(trace.decisionKind).toBe("missing");
    expect(trace.candidateCount).toBe(0);
    expect(trace.selectedPattern).toBeNull();
  });

  test("unauthenticated decision has zero candidates", () => {
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

  test("ask_missing_credential includes matching pattern count", () => {
    const decision: PolicyDecision = {
      kind: "ask_missing_credential",
      target: {
        hostname: "api.fal.ai",
        port: 443,
        path: "/v1",
        scheme: "https",
      },
      matchingPatterns: ["*.fal.ai", "api.fal.ai"],
    };
    const trace = buildDecisionTrace(
      "api.fal.ai",
      443,
      "/v1",
      "https",
      decision,
    );
    expect(trace.decisionKind).toBe("ask_missing_credential");
    expect(trace.candidateCount).toBe(2);
  });

  test("ask_unauthenticated has zero candidates", () => {
    const decision: PolicyDecision = {
      kind: "ask_unauthenticated",
      target: {
        hostname: "example.com",
        port: null,
        path: "/",
        scheme: "https",
      },
    };
    const trace = buildDecisionTrace(
      "example.com",
      null,
      "/",
      "https",
      decision,
    );
    expect(trace.decisionKind).toBe("ask_unauthenticated");
    expect(trace.candidateCount).toBe(0);
  });

  test("strips query parameters from path to prevent secret leakage", () => {
    const decision: PolicyDecision = {
      kind: "matched",
      credentialId: "cred-fal",
      template: {
        hostPattern: "*.fal.ai",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Key ",
      },
    };
    const trace = buildDecisionTrace(
      "api.fal.ai",
      443,
      "/v1/run?api_key=sk-secret-123&token=abc",
      "https",
      decision,
    );
    expect(trace.path).toBe("/v1/run");
    expect(JSON.stringify(trace)).not.toContain("sk-secret-123");
    expect(JSON.stringify(trace)).not.toContain("abc");
  });

  test("path without query string is unchanged", () => {
    const decision: PolicyDecision = { kind: "missing" };
    const trace = buildDecisionTrace(
      "example.com",
      443,
      "/v1/models",
      "https",
      decision,
    );
    expect(trace.path).toBe("/v1/models");
  });

  test("trace never contains secret values", () => {
    const decision: PolicyDecision = {
      kind: "matched",
      credentialId: "cred-fal",
      template: {
        hostPattern: "*.fal.ai",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Key ",
      },
    };
    const trace = buildDecisionTrace("api.fal.ai", 443, "/", "https", decision);
    const serialized = JSON.stringify(trace);
    // Should not contain any typical secret patterns
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("Key ");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token");
    // Should only contain expected fields
    const keys = Object.keys(trace);
    expect(keys).toEqual([
      "host",
      "port",
      "path",
      "scheme",
      "decisionKind",
      "candidateCount",
      "selectedPattern",
      "selectedCredentialId",
    ]);
  });
});

describe("buildCredentialRefTrace", () => {
  test("builds trace with all fields", () => {
    const trace = buildCredentialRefTrace(
      ["fal/api_key", "unknown/ref"],
      ["uuid-123"],
      ["unknown/ref"],
    );
    expect(trace).toEqual<CredentialRefTrace>({
      rawRefs: ["fal/api_key", "unknown/ref"],
      resolvedIds: ["uuid-123"],
      unresolvedRefs: ["unknown/ref"],
    });
  });

  test("empty arrays for clean resolution", () => {
    const trace = buildCredentialRefTrace(["uuid-abc"], ["uuid-abc"], []);
    expect(trace.unresolvedRefs).toEqual([]);
    expect(trace.resolvedIds).toEqual(["uuid-abc"]);
  });
});
