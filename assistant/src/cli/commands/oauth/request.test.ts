import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ipcCalls: string[] = [];
const handleRequestCalls: unknown[] = [];

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push(method);
    return { ok: false, error: `Unexpected IPC method ${method}` };
  },
  exitFromIpcResult: (r: { error?: string }) => {
    throw new Error(r.error ?? "IPC error");
  },
}));

mock.module("../../../runtime/routes/oauth-commands-routes.js", () => ({
  handleRequest: async (args: unknown) => {
    handleRequestCalls.push(args);
    return {
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
      account: "user@example.com",
    };
  },
}));

import { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { oauthHelp } from "./index.help.js";
import { registerRequestCommand } from "./request.js";

beforeEach(() => {
  ipcCalls.length = 0;
  handleRequestCalls.length = 0;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

async function runRequestCommand(extraArgs: string[] = []): Promise<{
  stdout: string;
}> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  const program = new Command();
  const oauth = program.command("oauth");
  applyCommandHelp(oauth, oauthHelp);
  registerRequestCommand(oauth);

  try {
    await program.parseAsync([
      "node",
      "assistant",
      "oauth",
      "request",
      "--provider",
      "google",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ...extraArgs,
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }

  return { stdout: chunks.join("") };
}

describe("assistant oauth request", () => {
  test("runs handleRequest in-process and does not call IPC", async () => {
    const { stdout } = await runRequestCommand(["-s"]);

    expect(ipcCalls).toEqual([]);
    expect(handleRequestCalls).toEqual([
      {
        body: {
          provider: "google",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        },
      },
    ]);
    expect(stdout).toContain("hello");
  });
});
