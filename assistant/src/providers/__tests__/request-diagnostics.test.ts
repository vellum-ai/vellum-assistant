/**
 * Tests for per-request provider diagnostics: what URL went out, what came
 * back, and whether a missing upstream error body means "the upstream sent
 * nothing" or "we failed to read it".
 */

import { afterAll, describe, expect, test } from "bun:test";

import {
  recordProviderRequestDiagnostics,
  redactUrl,
  runWithProviderRequestDiagnostics,
} from "../request-diagnostics.js";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/empty-404") {
      return new Response(null, { status: 404 });
    }
    if (pathname === "/verbose-404") {
      return new Response(
        JSON.stringify({ error: { code: 404, message: "model not found" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("ok");
  },
});
const origin = `http://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("redactUrl", () => {
  test("masks credential-bearing query parameters and userinfo", () => {
    // GIVEN a Gemini-style URL that carries the API key in the query string
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?key=super-secret&alt=sse`;

    // WHEN it is redacted for diagnostics
    const redacted = redactUrl(url);

    // THEN the path and non-credential params survive verbatim
    expect(redacted).toContain(
      "/v1beta/models/gemini-3-pro:streamGenerateContent",
    );
    expect(redacted).toContain("alt=sse");

    // AND the key is masked
    expect(redacted).toContain("key=REDACTED");
    expect(redacted).not.toContain("super-secret");
  });
});

describe("runWithProviderRequestDiagnostics", () => {
  test("reports the outbound URL, status and verbatim upstream error body", async () => {
    // GIVEN an upstream that answers a request with a non-empty 404 body
    const path = "/verbose-404?key=super-secret";

    // WHEN the request runs inside a diagnostics scope
    const outcome = await runWithProviderRequestDiagnostics(async () => {
      recordProviderRequestDiagnostics({
        model_id: "gemini-3-pro",
        connection_name: "gemini-personal",
      });
      const response = await fetch(`${origin}${path}`);
      // The SDK's own read must still work after diagnostics captured the body.
      return response.text();
    });

    // THEN the call's own body read is unaffected
    expect(outcome.ok).toBe(true);

    // AND the evidence identifies the exact request and the verbatim response
    expect(outcome.diagnostics).toEqual({
      resolved_url: `${origin}/verbose-404?key=REDACTED`,
      model_id: "gemini-3-pro",
      connection_name: "gemini-personal",
      http_status: 404,
      upstream_error_body: JSON.stringify({
        error: { code: 404, message: "model not found" },
      }),
      upstream_error_body_state: "captured",
      upstream_error_body_bytes: 50,
    });
  });

  test("distinguishes an upstream that sent no body from a body we never captured", async () => {
    // GIVEN an upstream that answers 404 with an empty body
    // WHEN the request runs inside a diagnostics scope
    const outcome = await runWithProviderRequestDiagnostics(() =>
      fetch(`${origin}/empty-404`),
    );

    // THEN the emptiness is recorded as an observation, not as missing evidence
    expect(outcome.diagnostics.http_status).toBe(404);
    expect(outcome.diagnostics.upstream_error_body_state).toBe("empty");
    expect(outcome.diagnostics.upstream_error_body_bytes).toBe(0);
    expect(outcome.diagnostics.upstream_error_body).toBeUndefined();
  });

  test("keeps the diagnostics collected before a thrown failure", async () => {
    // GIVEN a request that fails after reaching the upstream
    const boom = new Error("stream aborted");

    // WHEN it throws inside the diagnostics scope
    const outcome = await runWithProviderRequestDiagnostics(async () => {
      await fetch(`${origin}/verbose-404`);
      throw boom;
    });

    // THEN the failure is returned with the evidence gathered up to that point
    expect(outcome).toMatchObject({ ok: false, error: boom });
    expect(outcome.diagnostics.resolved_url).toBe(`${origin}/verbose-404`);
    expect(outcome.diagnostics.http_status).toBe(404);
  });

  test("leaves requests made outside a scope unrecorded", async () => {
    // GIVEN an outer scope whose work finished
    const outer = await runWithProviderRequestDiagnostics(async () => "done");

    // WHEN a request is made outside any diagnostics scope
    const response = await fetch(`${origin}/verbose-404`);

    // THEN it still completes normally and records nothing
    expect(response.status).toBe(404);
    expect(outer.diagnostics).toEqual({});
  });
});
