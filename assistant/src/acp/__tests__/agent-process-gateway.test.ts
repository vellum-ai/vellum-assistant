/**
 * Gateway-mode auth tests for `AcpAgentProcess.initialize()`.
 *
 * The `./gateway-auth.js` resolver is mocked so the three gate states can be
 * driven without real config / managed-proxy setup. The ACP connection is
 * stubbed directly (no child process): the tests assert what `initialize()`
 * advertises as client capabilities and whether it proactively authenticates
 * against the adapter's `gateway` method.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AuthMethod, InitializeResponse } from "@agentclientprotocol/sdk";

// Controls resolveAcpGatewayAuth() per test. undefined = gate off (flag off or
// managed-proxy prereqs unmet); an object = gate active.
let gatewayAuthResult:
  | { baseUrl: string; headers: Record<string, string> }
  | undefined;

mock.module("../gateway-auth.js", () => ({
  GATEWAY_AUTH_METHOD_ID: "gateway",
  resolveAcpGatewayAuth: async () => gatewayAuthResult,
}));

import { AcpAgentProcess } from "../agent-process.js";

interface StubConnection {
  initialize: (params: Record<string, unknown>) => Promise<InitializeResponse>;
  authenticate: (params: Record<string, unknown>) => Promise<unknown>;
  initializeCalls: Record<string, unknown>[];
  authenticateCalls: Record<string, unknown>[];
}

function makeConnection(authMethods: AuthMethod[]): StubConnection {
  const initializeCalls: Record<string, unknown>[] = [];
  const authenticateCalls: Record<string, unknown>[] = [];
  return {
    initializeCalls,
    authenticateCalls,
    initialize: (params) => {
      initializeCalls.push(params);
      return Promise.resolve({ protocolVersion: 1, authMethods });
    },
    authenticate: (params) => {
      authenticateCalls.push(params);
      return Promise.resolve({});
    },
  };
}

function newProcessWith(conn: StubConnection): AcpAgentProcess {
  const proc = new AcpAgentProcess(
    "test-agent",
    { command: "noop", args: [] },
    () => {
      throw new Error("client factory should not be called in this test");
    },
  );
  (proc as unknown as { connection: unknown }).connection = conn;
  return proc;
}

const gatewayMethod: AuthMethod = { id: "gateway", name: "Gateway" };

describe("AcpAgentProcess.initialize gateway auth", () => {
  beforeEach(() => {
    gatewayAuthResult = undefined;
  });

  test("(a) gate off: no auth capability advertised, no authenticate call", async () => {
    // Even if the adapter advertises a gateway method, an off gate must not
    // advertise the capability nor authenticate — identical to prior behavior.
    const conn = makeConnection([gatewayMethod]);
    const proc = newProcessWith(conn);

    await proc.initialize();

    expect(conn.initializeCalls[0].clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
    expect(conn.authenticateCalls).toHaveLength(0);
  });

  test("(b) gate on + gateway advertised: advertises capability and authenticates with baseUrl + x-api-key", async () => {
    gatewayAuthResult = {
      baseUrl: "https://platform.example.com/v1/runtime-proxy/anthropic",
      headers: {
        "x-api-key": "sk-assistant-123",
        "X-Vellum-LLM-Call-Site": "acp-child",
      },
    };
    const conn = makeConnection([gatewayMethod]);
    const proc = newProcessWith(conn);

    await proc.initialize();

    expect(
      (conn.initializeCalls[0].clientCapabilities as { auth?: unknown }).auth,
    ).toEqual({ _meta: { gateway: true } });

    expect(conn.authenticateCalls).toHaveLength(1);
    const call = conn.authenticateCalls[0]!;
    expect(call.methodId).toBe("gateway");
    expect(call._meta).toEqual({
      gateway: {
        baseUrl: "https://platform.example.com/v1/runtime-proxy/anthropic",
        headers: {
          "x-api-key": "sk-assistant-123",
          "X-Vellum-LLM-Call-Site": "acp-child",
        },
      },
    });
  });

  test("(c) gate on but adapter does NOT advertise gateway: capability advertised, no authenticate, no throw", async () => {
    gatewayAuthResult = {
      baseUrl: "https://platform.example.com/v1/runtime-proxy/anthropic",
      headers: { "x-api-key": "sk-assistant-123" },
    };
    // Version-skew: adapter offers only an env_var method, not gateway.
    const conn = makeConnection([
      {
        type: "env_var",
        id: "anthropic-api-key",
        name: "Use ANTHROPIC_API_KEY",
        vars: [],
      },
    ]);
    const proc = newProcessWith(conn);

    await expect(proc.initialize()).resolves.toBeDefined();

    expect(
      (conn.initializeCalls[0].clientCapabilities as { auth?: unknown }).auth,
    ).toEqual({ _meta: { gateway: true } });
    expect(conn.authenticateCalls).toHaveLength(0);
  });
});
