import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the gateway IPC client before importing the route under test.
let gatewayResult: unknown;
let gatewayCalls: Array<{ method: string; params: unknown }> = [];
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (method: string, params?: unknown) => {
    gatewayCalls.push({ method, params });
    return gatewayResult;
  },
}));

import { ROUTES } from "../runtime/routes/credential-request-routes.js";

const route = ROUTES.find(
  (r) => r.operationId === "credential_requests_create",
);

type MintResponse = {
  ok: boolean;
  url?: string;
  token?: string;
  expiresAt?: number;
  error?: string;
};

describe("credential-requests mint route", () => {
  beforeEach(() => {
    gatewayCalls = [];
    gatewayResult = {
      ok: true,
      token: "tok",
      url: "https://x.test/assistant/credentials/enter?token=tok",
      expiresAt: 123,
    };
  });

  test("relays the gateway mint result", async () => {
    const result = (await route!.handler({
      body: { service: "github", field: "api_token", label: "GitHub" },
    })) as MintResponse;

    expect(result.ok).toBe(true);
    expect(result.url).toBe(
      "https://x.test/assistant/credentials/enter?token=tok",
    );
    expect(gatewayCalls).toEqual([
      {
        method: "create_credential_request",
        params: { service: "github", field: "api_token", label: "GitHub" },
      },
    ]);
  });

  test("maps gateway error codes to user-facing messages", async () => {
    gatewayResult = { ok: false, error: "no_public_base_url" };
    const result = (await route!.handler({
      body: { service: "github", field: "api_token" },
    })) as MintResponse;

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "No public ingress URL is configured — set ingress.publicBaseUrl first",
    );
  });

  test("reports an unreachable gateway distinctly", async () => {
    gatewayResult = undefined;
    const result = (await route!.handler({
      body: { service: "github", field: "api_token" },
    })) as MintResponse;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("The gateway is not reachable");
  });
});
