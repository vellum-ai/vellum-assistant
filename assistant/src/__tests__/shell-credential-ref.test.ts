import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock logger
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock registry
mock.module("../tools/registry.js", () => ({
  registerTool: () => {},
}));

// Mock config
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    timeouts: { shellDefaultTimeoutSec: 120, shellMaxTimeoutSec: 600 },
    sandbox: { enabled: false, backend: "none" },
    secretDetection: { allowOneTimeSend: false },
  }),
}));

// Mock secret scanner
mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (s: string) => s,
}));

// Mock sandbox
mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: (cmd: string, _cwd: string) => ({
    command: "/bin/sh",
    args: ["-c", cmd],
  }),
}));

// Mock safe-env
mock.module("../tools/terminal/safe-env.js", () => ({
  buildSanitizedEnv: () => ({ PATH: "/usr/bin" }),
}));

// Mock platform
mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/test-data",
}));

// Mock proxy session manager
const mockGetOrStartSession = mock((_convId: string, _credIds: string[]) =>
  Promise.resolve({
    session: { id: "test-session-id", port: 8080, status: "active" },
    created: true,
  }),
);
const mockGetSessionEnv = mock(() => ({
  HTTP_PROXY: "http://127.0.0.1:8080",
  HTTPS_PROXY: "http://127.0.0.1:8080",
  NO_PROXY: "localhost",
}));
mock.module("../tools/network/script-proxy/index.js", () => ({
  getOrStartSession: mockGetOrStartSession,
  getSessionEnv: mockGetSessionEnv,
}));

// Set up metadata store for credential resolution
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-shell-cred-ref-test-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

// Import the shell tool after mocks
import { shellTool } from "../tools/terminal/shell.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "test-conv",
  trustClass: "guardian",
};

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(META_PATH);
  mockGetOrStartSession.mockClear();
  mockGetSessionEnv.mockClear();
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mock.restore();
});

describe("shell tool credential ref resolution", () => {
  test("service/field ref resolves to UUID and reaches session creation", async () => {
    const meta = upsertCredentialMetadata("fal", "api_key", {
      injectionTemplates: [
        {
          hostPattern: "*.fal.ai",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Key ",
        },
      ],
    });

    await shellTool.execute(
      {
        command: "echo hello",
        reason: "test",
        network_mode: "proxied",
        credential_ids: ["fal/api_key"],
      },
      ctx,
    );

    // Should have called getOrStartSession with the resolved UUID
    expect(mockGetOrStartSession).toHaveBeenCalledTimes(1);
    const callArgs = mockGetOrStartSession.mock.calls[0];
    expect(callArgs[1]).toEqual([meta.credentialId]);
  });

  test("UUID ref remains supported", async () => {
    const meta = upsertCredentialMetadata("github", "token");

    await shellTool.execute(
      {
        command: "echo hello",
        reason: "test",
        network_mode: "proxied",
        credential_ids: [meta.credentialId],
      },
      ctx,
    );

    expect(mockGetOrStartSession).toHaveBeenCalledTimes(1);
    const callArgs = mockGetOrStartSession.mock.calls[0];
    expect(callArgs[1]).toEqual([meta.credentialId]);
  });

  test("unknown ref fails fast before spawning", async () => {
    const result = await shellTool.execute(
      {
        command: "echo hello",
        reason: "test",
        network_mode: "proxied",
        credential_ids: ["nonexistent/key"],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown credential reference");
    expect(result.content).toContain("nonexistent/key");
    // Conversation should NOT have been created
    expect(mockGetOrStartSession).not.toHaveBeenCalled();
  });

  test("mixed known+unknown refs fails fast (no partial execution)", async () => {
    upsertCredentialMetadata("fal", "api_key");

    const result = await shellTool.execute(
      {
        command: "echo hello",
        reason: "test",
        network_mode: "proxied",
        credential_ids: ["fal/api_key", "unknown/ref"],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown credential reference");
    expect(result.content).toContain("unknown/ref");
    expect(mockGetOrStartSession).not.toHaveBeenCalled();
  });

  test("duplicate refs are deduped", async () => {
    const meta = upsertCredentialMetadata("fal", "api_key");

    await shellTool.execute(
      {
        command: "echo hello",
        reason: "test",
        network_mode: "proxied",
        credential_ids: ["fal/api_key", meta.credentialId],
      },
      ctx,
    );

    expect(mockGetOrStartSession).toHaveBeenCalledTimes(1);
    const callArgs = mockGetOrStartSession.mock.calls[0];
    // Should be deduped to a single UUID
    expect(callArgs[1]).toEqual([meta.credentialId]);
  });

  test("non-proxied mode passes refs through without resolution", async () => {
    // In non-proxied mode, credential_ids are ignored for proxy but still collected
    const result = await shellTool.execute(
      {
        command: "echo hello",
        reason: "test",
        network_mode: "off",
        credential_ids: ["unknown/ref"],
      },
      ctx,
    );

    // Should not fail — credential resolution only happens in proxied mode
    expect(result.isError).toBeFalsy();
    expect(mockGetOrStartSession).not.toHaveBeenCalled();
  });
});
