/**
 * CLI plumbing tests for `assistant/src/cli/commands/oauth/`.
 *
 * The oauth CLI commands are thin wrappers around `cliIpcCall(...)`; daemon
 * route handlers in `runtime/routes/oauth-commands-routes.ts` execute the
 * actual work. Tests here focus on argument handling and helpers that live
 * entirely in the CLI process.
 *
 * What lives here today:
 *   - `requirePlatformConnection` helper — gates managed-mode operations on
 *     a connected platform; used by multiple oauth subcommands.
 *
 * Daemon-side coverage of the IPC endpoints lives in
 * `oauth-commands-routes.test.ts`. Underlying store and token-refresh logic
 * is covered by `oauth-store.test.ts` and `credential-vault.test.ts`.
 *
 * Follow-up opportunities for CLI-layer coverage:
 *   - `exitFromIpcResult` exit-code mapping
 *   - `shouldOutputJson` / `writeOutput` output formatting
 *   - per-subcommand argument parsing & help text
 */

import { describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let mockPlatformClientCreate: () => Promise<Record<
  string,
  unknown
> | null> = async () => null;

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => mockPlatformClientCreate(),
  },
}));

mock.module("../util/logger.js", () => ({
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

const { requirePlatformConnection } =
  await import("../cli/commands/oauth/shared.js");

// ---------------------------------------------------------------------------
// requirePlatformConnection
// ---------------------------------------------------------------------------

describe("requirePlatformConnection", () => {
  test("returns false and writes error when not connected", async () => {
    mockPlatformClientCreate = async () => null;
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = 0;

    try {
      const cmd = new Command();
      cmd.option("--json");
      cmd.parse(["node", "test", "--json"]);
      const result = await requirePlatformConnection(cmd);
      expect(result).toBe(false);
      expect(process.exitCode).toBe(1);
      const output = stdoutChunks.join("");
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("vellum platform connect");
      expect(parsed.error).toContain("Not connected");
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = 0;
    }
  });

  test("returns true when client can be created (even without assistant ID)", async () => {
    mockPlatformClientCreate = async () => ({
      platformAssistantId: "",
      fetch: async () => new Response(),
    });
    process.exitCode = 0;

    const cmd = new Command();
    cmd.option("--json");
    cmd.parse(["node", "test", "--json"]);
    const result = await requirePlatformConnection(cmd);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("returns true when client can be created with assistant ID", async () => {
    mockPlatformClientCreate = async () => ({
      platformAssistantId: "asst-456",
      fetch: async () => new Response(),
    });
    process.exitCode = 0;

    const cmd = new Command();
    cmd.option("--json");
    cmd.parse(["node", "test", "--json"]);
    const result = await requirePlatformConnection(cmd);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(0);
  });
});
