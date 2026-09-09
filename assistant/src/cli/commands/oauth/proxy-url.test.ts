import { beforeEach, describe, expect, mock, test } from "bun:test";

const ipcCalls: Array<{ method: string; params: unknown }> = [];

let ipcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true };

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params: unknown) => {
    ipcCalls.push({ method, params });
    return ipcResult;
  },
  exitFromIpcResult: (r: { error?: string }) => {
    throw new Error(r.error ?? "IPC error");
  },
}));

import { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { oauthHelp } from "./index.help.js";
import { registerProxyUrlCommand } from "./proxy-url.js";

const GRANT = {
  ok: true,
  provider: "stripe_link",
  account: "user@example.com",
  baseUrl: "https://gateway.example.com/v1/oauth/proxy/stripe_link",
  path: "/v1/oauth/proxy/stripe_link",
  token: "grant-abc123",
  expiresAt: "2026-01-01T00:15:00.000Z",
  ttlSeconds: 900,
};

beforeEach(() => {
  ipcCalls.length = 0;
  process.exitCode = 0;
  ipcResult = { ok: true, result: { ...GRANT } };
});

async function runProxyUrl(args: string[]): Promise<{
  stdout: string;
  exitCode: number;
  error?: Error;
}> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stdout.write;

  let error: Error | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    const oauth = program.command("oauth").description(oauthHelp.description);
    applyCommandHelp(oauth, oauthHelp);
    registerProxyUrlCommand(oauth);
    const proxyUrl = oauth.commands.find((c) => c.name() === "proxy-url");
    proxyUrl?.option("--json");
    await program.parseAsync(["node", "test", "oauth", "proxy-url", ...args]);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    process.stdout.write = originalWrite;
  }

  return {
    stdout: chunks.join(""),
    exitCode: Number(process.exitCode ?? 0),
    error,
  };
}

describe("assistant oauth proxy-url", () => {
  test("sends only the provider when no options are given", async () => {
    await runProxyUrl(["stripe_link"]);

    expect(ipcCalls).toEqual([
      {
        method: "oauth_proxy_grant",
        params: { body: { provider: "stripe_link" } },
      },
    ]);
  });

  test("forwards --account and --ttl in the request body", async () => {
    await runProxyUrl([
      "stripe_link",
      "--account",
      "user@example.com",
      "--ttl",
      "120",
    ]);

    expect(ipcCalls).toEqual([
      {
        method: "oauth_proxy_grant",
        params: {
          body: {
            provider: "stripe_link",
            account: "user@example.com",
            ttlSeconds: 120,
          },
        },
      },
    ]);
  });

  test("prints the grant as pretty JSON by default", async () => {
    const { stdout, exitCode } = await runProxyUrl(["stripe_link"]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(JSON.stringify(GRANT, null, 2) + "\n");
  });

  test("prints compact JSON with --json", async () => {
    const { stdout } = await runProxyUrl(["--json", "stripe_link"]);

    expect(stdout).toBe(JSON.stringify(GRANT) + "\n");
  });

  test("prints four export lines with --export, escaping single quotes", async () => {
    ipcResult = {
      ok: true,
      result: { ...GRANT, account: "o'brien@example.com" },
    };

    const { stdout } = await runProxyUrl(["stripe_link", "--export"]);

    expect(stdout.split("\n")).toEqual([
      `export VELLUM_OAUTH_PROXY_BASE_URL='${GRANT.baseUrl}'`,
      `export VELLUM_OAUTH_PROXY_TOKEN='${GRANT.token}'`,
      `export VELLUM_OAUTH_PROXY_EXPIRES_AT='${GRANT.expiresAt}'`,
      `export VELLUM_OAUTH_PROXY_ACCOUNT='o'\\''brien@example.com'`,
      "",
    ]);
  });

  test("omits the account export line when the grant carries no account", async () => {
    ipcResult = { ok: true, result: { ...GRANT, account: null } };

    const { stdout } = await runProxyUrl(["stripe_link", "--export"]);

    expect(stdout).not.toContain("VELLUM_OAUTH_PROXY_ACCOUNT");
    expect(stdout.trimEnd().split("\n")).toHaveLength(3);
  });

  test("--export ignores --json", async () => {
    const { stdout } = await runProxyUrl(["--json", "stripe_link", "--export"]);

    expect(stdout.startsWith("export VELLUM_OAUTH_PROXY_BASE_URL=")).toBe(true);
  });

  test("rejects a non-integer --ttl without calling IPC", async () => {
    const { exitCode } = await runProxyUrl(["stripe_link", "--ttl", "abc"]);

    expect(ipcCalls).toEqual([]);
    expect(exitCode).toBe(2);
  });

  test("surfaces an IPC error through exitFromIpcResult", async () => {
    ipcResult = {
      ok: false,
      error: "Unknown provider: nope",
      statusCode: 404,
    };

    const { error } = await runProxyUrl(["nope"]);

    expect(error?.message).toBe("Unknown provider: nope");
  });
});
