import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let gatewayBase = "http://gateway.test";
let signingKeyInitialized = false;
let initCalls = 0;
let loadCalls = 0;
let mintCalls = 0;
let rawConfig: Record<string, unknown> = {};

mock.module("../config/env.js", () => ({
  getGatewayInternalBaseUrl: () => gatewayBase,
}));

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => rawConfig,
}));

mock.module("../config/elevenlabs-schema.js", () => ({
  DEFAULT_ELEVENLABS_VOICE_ID: "21m00Tcm4TlvDq8ikWAM",
}));

mock.module("../runtime/auth/token-service.js", () => ({
  isSigningKeyInitialized: () => signingKeyInitialized,
  initAuthSigningKey: (_key: Buffer) => {
    signingKeyInitialized = true;
    initCalls += 1;
  },
  loadOrCreateSigningKey: () => {
    loadCalls += 1;
    return Buffer.alloc(32, 7);
  },
  mintEdgeRelayToken: () => {
    mintCalls += 1;
    return "minted-edge-token";
  },
}));

const { registerIntegrationsCommand } = await import("../cli/integrations.js");

type FetchCall = { url: string; authHeader: string | null };

async function runCli(
  args: string[],
  responseBody: unknown,
  responseStatus = 200,
): Promise<{ exitCode: number; stdout: string; fetchCalls: FetchCall[] }> {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalEnvToken = process.env.GATEWAY_AUTH_TOKEN;

  const fetchCalls: FetchCall[] = [];
  const stdoutChunks: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      authHeader: headers.get("authorization"),
    });
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    registerIntegrationsCommand(program);
    await program.parseAsync(["node", "vellum", "integrations", ...args]);
  } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    if (originalEnvToken === undefined) {
      delete process.env.GATEWAY_AUTH_TOKEN;
    } else {
      process.env.GATEWAY_AUTH_TOKEN = originalEnvToken;
    }
  }

  return {
    exitCode: process.exitCode ?? 0,
    stdout: stdoutChunks.join(""),
    fetchCalls,
  };
}

describe("assistant integrations CLI", () => {
  beforeEach(() => {
    gatewayBase = "http://gateway.test";
    signingKeyInitialized = false;
    initCalls = 0;
    loadCalls = 0;
    mintCalls = 0;
    rawConfig = {};
    delete process.env.GATEWAY_AUTH_TOKEN;
    process.exitCode = 0;
  });

  afterEach(() => {
    delete process.env.GATEWAY_AUTH_TOKEN;
    process.exitCode = 0;
  });

  test("uses GATEWAY_AUTH_TOKEN from env when present", async () => {
    process.env.GATEWAY_AUTH_TOKEN = "env-token";
    const result = await runCli(["--json", "twilio", "config"], {
      success: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(1);
    expect(result.fetchCalls[0]?.url).toBe(
      "http://gateway.test/v1/integrations/twilio/config",
    );
    expect(result.fetchCalls[0]?.authHeader).toBe("Bearer env-token");
    expect(loadCalls).toBe(0);
    expect(initCalls).toBe(0);
    expect(mintCalls).toBe(0);
  });

  test("mints a gateway token when no env token is provided", async () => {
    const result = await runCli(["--json", "telegram", "config"], {
      success: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls[0]?.authHeader).toBe("Bearer minted-edge-token");
    expect(loadCalls).toBe(1);
    expect(initCalls).toBe(1);
    expect(mintCalls).toBe(1);
  });

  test("uses configured gateway base for requests", async () => {
    gatewayBase = "http://gateway.internal:9900";
    const result = await runCli(["--json", "twilio", "config"], {
      success: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls[0]?.url).toBe(
      "http://gateway.internal:9900/v1/integrations/twilio/config",
    );
  });

  test("passes channel query for guardian status", async () => {
    const result = await runCli(
      ["--json", "guardian", "status", "--channel", "telegram"],
      { success: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls[0]?.url).toBe(
      "http://gateway.test/v1/integrations/guardian/status?channel=telegram",
    );
  });

  test("reads ingress config without gateway fetch", async () => {
    rawConfig = {
      ingress: {
        enabled: true,
        publicBaseUrl: "https://public.example.com",
      },
    };
    const result = await runCli(["--json", "ingress", "config"], { ok: true });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      enabled: true,
      publicBaseUrl: "https://public.example.com",
      localGatewayTarget: "http://gateway.test",
    });
  });

  test("reads voice config without gateway fetch", async () => {
    rawConfig = {
      calls: {
        enabled: true,
      },
      elevenlabs: {
        voiceId: "EXAVITQu4vr4xnSDxMaL",
      },
    };
    const result = await runCli(["--json", "voice", "config"], { ok: true });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      callsEnabled: true,
      voiceId: "EXAVITQu4vr4xnSDxMaL",
      configuredVoiceId: "EXAVITQu4vr4xnSDxMaL",
      usesDefaultVoice: false,
    });
  });

  test("voice config reports default voice when unset", async () => {
    rawConfig = {};
    const result = await runCli(["--json", "voice", "config"], { ok: true });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      callsEnabled: false,
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      usesDefaultVoice: true,
    });
  });

  test("returns structured error output when gateway request fails", async () => {
    const result = await runCli(
      ["--json", "twilio", "numbers"],
      { error: "Unauthorized" },
      401,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "Unauthorized [401]",
    });
  });
});
