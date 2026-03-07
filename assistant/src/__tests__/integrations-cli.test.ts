import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let gatewayBase = "http://gateway.test";
let signingKeyInitialized = false;
let initCalls = 0;
let loadCalls = 0;
let mintCalls = 0;
let rawConfig: Record<string, unknown> = {};
let twilioHasCredentials = false;
let twilioAccountSid = "AC1234567890";
let twilioAuthToken = "twilio-auth-token";
let twilioNumbers = [
  {
    phoneNumber: "+15550001111",
    friendlyName: "Primary number",
    capabilities: { voice: true, sms: true },
  },
];
let twilioListError: Error | undefined;
let twilioListCalls: Array<{ accountSid: string; authToken: string }> = [];

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

mock.module("../calls/twilio-rest.js", () => ({
  hasTwilioCredentials: () => twilioHasCredentials,
  getTwilioCredentials: () => {
    if (!twilioHasCredentials) {
      throw new Error("Twilio credentials not configured");
    }
    return {
      accountSid: twilioAccountSid,
      authToken: twilioAuthToken,
    };
  },
  listIncomingPhoneNumbers: async (accountSid: string, authToken: string) => {
    twilioListCalls.push({ accountSid, authToken });
    if (twilioListError) throw twilioListError;
    return twilioNumbers;
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

async function runHelp(args: string[]): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const program = new Command();
    program.exitOverride();
    registerIntegrationsCommand(program);

    try {
      await program.parseAsync(["node", "vellum", ...args]);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "commander.helpDisplayed") {
        throw error;
      }
    }
  } finally {
    process.stdout.write = originalWrite;
  }

  return stdoutChunks.join("");
}

describe("assistant integrations CLI", () => {
  beforeEach(() => {
    gatewayBase = "http://gateway.test";
    signingKeyInitialized = false;
    initCalls = 0;
    loadCalls = 0;
    mintCalls = 0;
    rawConfig = {};
    twilioHasCredentials = false;
    twilioAccountSid = "AC1234567890";
    twilioAuthToken = "twilio-auth-token";
    twilioNumbers = [
      {
        phoneNumber: "+15550001111",
        friendlyName: "Primary number",
        capabilities: { voice: true, sms: true },
      },
    ];
    twilioListError = undefined;
    twilioListCalls = [];
    delete process.env.GATEWAY_AUTH_TOKEN;
    process.exitCode = 0;
  });

  afterEach(() => {
    delete process.env.GATEWAY_AUTH_TOKEN;
    process.exitCode = 0;
  });

  test("uses GATEWAY_AUTH_TOKEN from env when present", async () => {
    process.env.GATEWAY_AUTH_TOKEN = "env-token";
    const result = await runCli(["--json", "telegram", "config"], {
      success: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(1);
    expect(result.fetchCalls[0]?.url).toBe(
      "http://gateway.test/v1/integrations/telegram/config",
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
    const result = await runCli(["--json", "telegram", "config"], {
      success: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls[0]?.url).toBe(
      "http://gateway.internal:9900/v1/integrations/telegram/config",
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

  test("lists twilio in integrations help output", async () => {
    const help = await runHelp(["integrations", "--help"]);

    expect(help).toContain("twilio");
    expect(help).toContain("assistant integrations twilio config");
    expect(help).toContain("assistant integrations twilio numbers --json");
  });

  test("includes extended help text for twilio namespace and subcommands", async () => {
    const twilioHelp = await runHelp(["integrations", "twilio", "--help"]);
    const configHelp = await runHelp([
      "integrations",
      "twilio",
      "config",
      "--help",
    ]);
    const numbersHelp = await runHelp([
      "integrations",
      "twilio",
      "numbers",
      "--help",
    ]);

    expect(twilioHelp).toContain("runtime routes");
    expect(twilioHelp).toContain("assistant integrations twilio numbers");
    expect(configHelp).toContain("Arguments:");
    expect(configHelp).toContain("does not call the gateway or Twilio");
    expect(numbersHelp).toContain("Arguments:");
    expect(numbersHelp).toContain("Calls the Twilio REST API directly");
  });

  test("reads twilio config without gateway fetch", async () => {
    rawConfig = {
      twilio: {
        phoneNumber: "+15550001111",
      },
    };
    twilioHasCredentials = true;
    twilioAccountSid = "AC9999999999";

    const result = await runCli(["--json", "twilio", "config"], { ok: true });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      hasCredentials: true,
      accountSid: "AC9999999999",
      phoneNumber: "+15550001111",
    });
  });

  test("reads twilio numbers through the shared service without gateway fetch", async () => {
    twilioHasCredentials = true;
    twilioAccountSid = "AC5555555555";
    twilioAuthToken = "auth-555";
    twilioNumbers = [
      {
        phoneNumber: "+15550002222",
        friendlyName: "Support line",
        capabilities: { voice: true, sms: true },
      },
    ];

    const result = await runCli(["--json", "twilio", "numbers"], {
      ok: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(0);
    expect(twilioListCalls).toEqual([
      { accountSid: "AC5555555555", authToken: "auth-555" },
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      hasCredentials: true,
      numbers: [
        {
          phoneNumber: "+15550002222",
          friendlyName: "Support line",
          capabilities: { voice: true, sms: true },
        },
      ],
    });
  });

  test("returns a structured twilio status when credentials are missing", async () => {
    const result = await runCli(["--json", "twilio", "numbers"], {
      ok: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.fetchCalls.length).toBe(0);
    expect(twilioListCalls).toEqual([]);
    expect(JSON.parse(result.stdout)).toEqual({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  });

  test("returns structured error output when twilio numbers lookup fails", async () => {
    twilioHasCredentials = true;
    twilioListError = new Error("Twilio API error 401: Unauthorized");

    const result = await runCli(["--json", "twilio", "numbers"], { ok: true });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "Twilio API error 401: Unauthorized",
    });
  });
});
