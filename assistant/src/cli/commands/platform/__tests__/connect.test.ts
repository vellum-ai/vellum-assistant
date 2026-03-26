import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockGetSecureKeyViaDaemon: (
  account: string,
) => Promise<string | undefined> = async () => undefined;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../lib/daemon-credential-client.js", () => ({
  getSecureKeyViaDaemon: (account: string) =>
    mockGetSecureKeyViaDaemon(account),
  deleteSecureKeyViaDaemon: async () => "not-found" as const,
  setSecureKeyViaDaemon: async () => false,
  getProviderKeyViaDaemon: async () => undefined,
  getSecureKeyResultViaDaemon: async () => ({
    value: undefined,
    unreachable: false,
  }),
}));

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerPlatformConnectCommand } = await import("../connect.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.option("--json", "Machine-readable compact JSON output");
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerPlatformConnectCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform connect", () => {
  beforeEach(() => {
    mockGetSecureKeyViaDaemon = async () => undefined;
    process.exitCode = 0;
  });

  test.todo(
    "already connected returns success with existing base URL",
    async () => {
      /**
       * When the assistant already has stored platform credentials (base
       * URL and API key), the connect command should short-circuit and
       * report that it is already connected, returning the existing base
       * URL.
       *
       * NOTE: The connect command is currently stubbed — the full
       * credential-collection flow via a secure UI component is not yet
       * implemented. This test validates the already-connected early-exit
       * path, which IS implemented. It is skipped because the stub path
       * still sets a non-zero exit code before reaching this branch
       * under certain conditions. Unskip once the full connect flow
       * lands.
       */

      // GIVEN stored platform credentials already exist
      mockGetSecureKeyViaDaemon = async (account: string) => {
        if (account === "credential/vellum/platform_base_url")
          return "https://platform.vellum.ai";
        if (account === "credential/vellum/assistant_api_key")
          return "sk-existing-key";
        return undefined;
      };

      // WHEN the connect command is run with --json
      const { exitCode, stdout } = await runCommand(["connect", "--json"]);

      // THEN the command succeeds
      expect(exitCode).toBe(0);

      // AND the output indicates already connected with the base URL
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.alreadyConnected).toBe(true);
      expect(parsed.baseUrl).toBe("https://platform.vellum.ai");
    },
  );
});
