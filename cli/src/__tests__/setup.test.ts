import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantEntry } from "../lib/assistant-config.js";
import {
  saveGuardianToken,
  type GuardianTokenData,
} from "../lib/guardian-token.js";
import { setup } from "../commands/setup.js";

interface RecordedFetchCall {
  url: string;
  method?: string;
  headers: Headers;
  body: unknown;
}

const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const originalEnv = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgDataHome: process.env.XDG_DATA_HOME,
  vellumEnvironment: process.env.VELLUM_ENVIRONMENT,
  vellumLockfileDir: process.env.VELLUM_LOCKFILE_DIR,
};

let testDir = "";
let fetchCalls: RecordedFetchCall[] = [];
let consoleLogSpy: Mock<(...args: unknown[]) => void>;
let consoleErrorSpy: Mock<(...args: unknown[]) => void>;

function guardianTokenFixture(
  overrides: Partial<GuardianTokenData> = {},
): GuardianTokenData {
  return {
    guardianPrincipalId: "guardian-principal-123",
    accessToken: "guardian-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    refreshAfter: new Date(Date.now() + 30_000).toISOString(),
    isNew: false,
    deviceId: "device-123",
    leasedAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeLockfile(entry: AssistantEntry): void {
  const lockfileDir = process.env.VELLUM_LOCKFILE_DIR!;
  mkdirSync(lockfileDir, { recursive: true });
  writeFileSync(
    join(lockfileDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: [entry],
        activeAssistant: entry.assistantId,
      },
      null,
      2,
    ),
  );
}

function installFetchStub(
  options: {
    leasedToken?: GuardianTokenData;
    refreshedToken?: GuardianTokenData;
  } = {},
) {
  fetchCalls = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const url = String(input);
    fetchCalls.push({
      url,
      method: init?.method,
      headers,
      body,
    });

    if (url.endsWith("/v1/guardian/refresh")) {
      if (!options.refreshedToken) {
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(options.refreshedToken), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/v1/guardian/init")) {
      if (!options.leasedToken) {
        return new Response(JSON.stringify({ error: "not allowed" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(options.leasedToken), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/v1/secrets/read")) {
      return new Response(JSON.stringify({ found: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/v1/secrets")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unexpected URL" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function secretWriteCall(): RecordedFetchCall {
  const call = fetchCalls.find((record) => record.url.endsWith("/v1/secrets"));
  if (!call) {
    throw new Error("Expected /v1/secrets call.");
  }
  return call;
}

describe("setup command", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vellum-setup-test-"));
    process.argv = ["bun", "vellum", "setup"];
    process.env.XDG_CONFIG_HOME = join(testDir, "config");
    process.env.XDG_DATA_HOME = join(testDir, "data");
    process.env.VELLUM_LOCKFILE_DIR = join(testDir, "lockfile");
    delete process.env.VELLUM_ENVIRONMENT;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    installFetchStub();
  });

  afterEach(() => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    setOptionalEnv("ANTHROPIC_API_KEY", originalEnv.anthropicApiKey);
    setOptionalEnv("OPENAI_API_KEY", originalEnv.openaiApiKey);
    setOptionalEnv("XDG_CONFIG_HOME", originalEnv.xdgConfigHome);
    setOptionalEnv("XDG_DATA_HOME", originalEnv.xdgDataHome);
    setOptionalEnv("VELLUM_ENVIRONMENT", originalEnv.vellumEnvironment);
    setOptionalEnv("VELLUM_LOCKFILE_DIR", originalEnv.vellumLockfileDir);
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("configures the default provider through the active assistant gateway", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      runtimeUrl: "http://runtime.example",
      localUrl: "http://127.0.0.1:3000",
      cloud: "local",
    });
    saveGuardianToken("assistant-123", guardianTokenFixture());

    await setup();

    expect(fetchCalls[0].url).toBe("http://127.0.0.1:3000/v1/secrets/read");
    expect(fetchCalls[0].headers.get("Authorization")).toBe(
      "Bearer guardian-token",
    );
    expect(secretWriteCall().body).toEqual({
      type: "api_key",
      name: "anthropic",
      value: "test-anthropic-key",
    });
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Anthropic API key saved to assistant from the environment.",
    );
  });

  test("honors an explicit provider option", async () => {
    process.argv = ["bun", "vellum", "setup", "--provider", "openai"];
    process.env.OPENAI_API_KEY = "test-openai-key";
    writeLockfile({
      assistantId: "assistant-123",
      runtimeUrl: "http://127.0.0.1:3000",
      cloud: "local",
    });
    saveGuardianToken("assistant-123", guardianTokenFixture());

    await setup();

    expect(secretWriteCall().body).toEqual({
      type: "api_key",
      name: "openai",
      value: "test-openai-key",
    });
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "OpenAI API key saved to assistant from the environment.",
    );
  });

  test("leases a guardian token for local assistants when no token exists", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      runtimeUrl: "http://runtime.example",
      localUrl: "http://127.0.0.1:3000",
      cloud: "local",
    });
    installFetchStub({
      leasedToken: guardianTokenFixture({
        accessToken: "leased-guardian-token",
      }),
    });

    await setup();

    expect(fetchCalls[0].url).toBe("http://127.0.0.1:3000/v1/guardian/init");
    expect(fetchCalls[1].url).toBe("http://127.0.0.1:3000/v1/secrets/read");
    expect(fetchCalls[1].headers.get("Authorization")).toBe(
      "Bearer leased-guardian-token",
    );
  });

  test("uses saved bootstrap secret when leasing a Docker guardian token", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      runtimeUrl: "http://localhost:7831",
      cloud: "docker",
      guardianBootstrapSecret: "test-bootstrap-secret",
    });
    installFetchStub({
      leasedToken: guardianTokenFixture({
        accessToken: "leased-docker-token",
      }),
    });

    await setup();

    expect(fetchCalls[0].url).toBe("http://localhost:7831/v1/guardian/init");
    expect(fetchCalls[0].headers.get("x-bootstrap-secret")).toBe(
      "test-bootstrap-secret",
    );
    expect(fetchCalls[1].headers.get("Authorization")).toBe(
      "Bearer leased-docker-token",
    );
  });

  test("falls back to runtime URL and lockfile bearer token", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      runtimeUrl: "https://assistant.example",
      bearerToken: "entry-token",
      cloud: "vellum",
    });

    await setup();

    expect(fetchCalls[0].url).toBe("https://assistant.example/v1/secrets/read");
    expect(fetchCalls[0].headers.get("Authorization")).toBe(
      "Bearer entry-token",
    );
  });

  test("falls back to the lockfile bearer token when guardian token is expired", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      runtimeUrl: "https://assistant.example",
      bearerToken: "entry-token",
      cloud: "vellum",
    });
    saveGuardianToken(
      "assistant-123",
      guardianTokenFixture({
        accessToken: "expired-guardian-token",
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    await setup();

    expect(fetchCalls[0].url).toBe(
      "https://assistant.example/v1/guardian/refresh",
    );
    expect(fetchCalls[0].headers.get("Authorization")).toBe(
      "Bearer expired-guardian-token",
    );
    expect(fetchCalls[1].headers.get("Authorization")).toBe(
      "Bearer entry-token",
    );
  });

  test("uses a refreshed guardian token before lockfile fallback", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    writeLockfile({
      assistantId: "assistant-123",
      runtimeUrl: "https://assistant.example",
      bearerToken: "entry-token",
      cloud: "vellum",
    });
    saveGuardianToken(
      "assistant-123",
      guardianTokenFixture({
        accessToken: "expired-guardian-token",
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    installFetchStub({
      refreshedToken: guardianTokenFixture({
        accessToken: "fresh-guardian-token",
      }),
    });

    await setup();

    expect(fetchCalls[0].url).toBe(
      "https://assistant.example/v1/guardian/refresh",
    );
    expect(fetchCalls[1].headers.get("Authorization")).toBe(
      "Bearer fresh-guardian-token",
    );
  });
});

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
