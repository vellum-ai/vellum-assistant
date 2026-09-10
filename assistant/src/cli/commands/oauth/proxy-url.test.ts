import { beforeEach, describe, expect, mock, test } from "bun:test";

const ipcCalls: Array<{ method: string; params: unknown }> = [];
const ipcExits: Array<unknown> = [];

let ipcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true };

let ipcThrow: Error | null = null;

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params: unknown) => {
    ipcCalls.push({ method, params });
    if (ipcThrow) {
      throw ipcThrow;
    }
    return ipcResult;
  },
  // The real helper writes to stderr and exits the process, so it never
  // returns. Throwing is the closest a double can get to `never`.
  exitFromIpcResult: (r: { error?: string }) => {
    ipcExits.push(r);
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
  ipcExits.length = 0;
  ipcThrow = null;
  process.exitCode = 0;
  ipcResult = { ok: true, result: { ...GRANT } };
});

async function runProxyUrl(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: Error;
}> {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
  const collect = (into: string[]) =>
    ((chunk: string | Uint8Array) => {
      into.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = collect(chunks);
  process.stderr.write = collect(errChunks);

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
    process.stderr.write = originalErrorWrite;
  }

  return {
    stdout: chunks.join(""),
    stderr: errChunks.join(""),
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

    await runProxyUrl(["nope"]);

    expect(ipcExits).toEqual([
      { ok: false, error: "Unknown provider: nope", statusCode: 404 },
    ]);
  });

  test("reports a thrown error on stderr and exits non-zero", async () => {
    ipcThrow = new Error("Assistant socket is unavailable");

    const { stdout, stderr, exitCode, error } = await runProxyUrl([
      "stripe_link",
    ]);

    expect(error).toBeUndefined();
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Error: Assistant socket is unavailable\n");
  });

  test("reports a thrown error as a JSON envelope with --json", async () => {
    ipcThrow = new Error("Assistant socket is unavailable");

    const { stdout, stderr, exitCode } = await runProxyUrl([
      "--json",
      "stripe_link",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "Assistant socket is unavailable",
    });
  });

  test("--export leaves stdout empty when the call throws", async () => {
    ipcThrow = new Error("Assistant socket is unavailable");

    const { stdout, stderr, exitCode } = await runProxyUrl([
      "stripe_link",
      "--export",
    ]);

    expect(stdout).toBe("");
    expect(stderr).toBe("Error: Assistant socket is unavailable\n");
    expect(exitCode).toBe(1);
  });

  test("--export keeps the JSON envelope off stdout with --json", async () => {
    // The caller evals stdout, so an error envelope there would be executed.
    ipcThrow = new Error("Assistant socket is unavailable");

    const { stdout, stderr, exitCode } = await runProxyUrl([
      "--json",
      "stripe_link",
      "--export",
    ]);

    expect(stdout).toBe("");
    expect(stderr).toBe("Error: Assistant socket is unavailable\n");
    expect(exitCode).toBe(1);
  });

  test("--export keeps a rejected --ttl off stdout with --json", async () => {
    const { stdout, stderr, exitCode } = await runProxyUrl([
      "--json",
      "stripe_link",
      "--export",
      "--ttl",
      "abc",
    ]);

    expect(ipcCalls).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toContain('Invalid --ttl "abc"');
    expect(exitCode).toBe(2);
  });
});
