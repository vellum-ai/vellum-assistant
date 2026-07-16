import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> =
  [];
const openedUrls: string[] = [];

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (method === "oauth_providers_by_providerKey_get") {
      return {
        ok: true,
        result: {
          provider: { authUrl: "https://accounts.example.com/oauth" },
        },
      };
    }
    if (method === "oauth_mode_get") {
      return { ok: true, result: { ok: true, mode: "managed" } };
    }
    if (method === "oauth_managed_connect_start") {
      return {
        ok: true,
        result: { ok: true, connect_url: "https://connect.example.com" },
      };
    }
    return { ok: false, error: `Unexpected IPC method ${method}` };
  },
  exitFromIpcResult: (r: { error?: string }) => {
    throw new Error(r.error ?? "IPC error");
  },
}));

mock.module("../../lib/open-browser.js", () => ({
  openInHostBrowser: (url: string) => {
    openedUrls.push(url);
  },
}));

mock.module("../../logger.js", () => ({
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { registerConnectCommand } from "./connect.js";
import { oauthHelp } from "./index.help.js";

const originalConversationId = process.env.__CONVERSATION_ID;

beforeEach(() => {
  ipcCalls.length = 0;
  openedUrls.length = 0;
  process.exitCode = 0;
  process.env.__CONVERSATION_ID = "conv-123";
});

afterEach(() => {
  if (originalConversationId === undefined) {
    delete process.env.__CONVERSATION_ID;
  } else {
    process.env.__CONVERSATION_ID = originalConversationId;
  }
  process.exitCode = 0;
});

async function runConnectCommand(): Promise<{
  stdout: string;
  exitCode: number;
}> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  try {
    const program = new Command();
    program.exitOverride();
    const oauth = program.command("oauth").description(oauthHelp.description);
    applyCommandHelp(oauth, oauthHelp);
    registerConnectCommand(oauth);
    await program.parseAsync([
      "node",
      "test",
      "oauth",
      "--json",
      "connect",
      "google",
    ]);
  } catch {
    // Commander may throw under exitOverride for parse errors; the assertions
    // below verify the command behavior we care about.
  } finally {
    process.stdout.write = originalWrite;
  }

  return { stdout: chunks.join(""), exitCode: Number(process.exitCode ?? 0) };
}

describe("oauth connect", () => {
  test("managed provider in a conversation shell returns oauth_connect guidance without opening a browser", async () => {
    const { stdout, exitCode } = await runConnectCommand();

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.code).toBe("use_oauth_connect_surface");
    expect(parsed.nextAction).toEqual({
      type: "ui_show",
      surfaceType: "oauth_connect",
      data: { providerKey: "google" },
    });
    expect(openedUrls).toEqual([]);
    expect(ipcCalls.map((call) => call.method)).toEqual([
      "oauth_providers_by_providerKey_get",
      "oauth_mode_get",
    ]);
  });
});
