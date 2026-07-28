import { afterEach, describe, expect, mock, test } from "bun:test";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { handleProbeRoute } from "./probe-routes.js";

const SERVICE_TOKEN = "service-token";
const STORED_KEY = "AIzaSyStoredKey";

const backend: SecureKeyBackend = {
  get: async () => STORED_KEY,
  set: async () => true,
  delete: async () => "deleted",
  list: async () => [],
};

const deps = { backend, serviceToken: SERVICE_TOKEN };

const probeRequest = (init?: RequestInit) =>
  new Request("http://ces/v1/probes/model-access", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      account: "credential/gemini-personal/api_key",
      request: {
        url: "https://generativelanguage.googleapis.com/v1beta/models",
        credentialInjection: { kind: "header", name: "x-goog-api-key" },
      },
      models: ["gemini-3.1-flash-lite"],
    }),
    ...init,
  });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("handleProbeRoute", () => {
  test("GIVEN a non-probe path WHEN handling THEN it falls through", async () => {
    expect(
      await handleProbeRoute(new Request("http://ces/v1/credentials"), deps),
    ).toBeNull();
  });

  test("GIVEN no bearer token WHEN handling THEN it is unauthorized and no credential is used", async () => {
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await handleProbeRoute(
      new Request("http://ces/v1/probes/model-access", { method: "POST" }),
      deps,
    );

    expect(response?.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("GIVEN a malformed body WHEN handling THEN it is rejected before any provider call", async () => {
    const response = await handleProbeRoute(
      new Request("http://ces/v1/probes/model-access", {
        method: "POST",
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
        body: JSON.stringify({ account: "x" }),
      }),
      deps,
    );

    expect(response?.status).toBe(400);
  });

  test("GIVEN a valid probe WHEN handling THEN it returns verdicts without the credential", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }] }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const response = await handleProbeRoute(probeRequest(), deps);
    const body = await response!.text();

    expect(response!.status).toBe(200);
    expect(body).not.toContain(STORED_KEY);
    expect(JSON.parse(body)).toMatchObject({
      outcome: "valid",
      models: [{ model: "gemini-3.1-flash-lite", access: "not_accessible" }],
    });
  });
});
