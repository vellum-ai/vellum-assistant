import { beforeEach, describe, expect, mock, test } from "bun:test";

// The command runs the authenticated-request route in-process, as `oauth
// request` does. The route is stubbed so the tests see exactly what provider
// key and request shape the command hands it; IPC is stubbed to prove the
// command never takes that path.
const ipcCalls: string[] = [];
const handleRequestCalls: Array<{ body: Record<string, unknown> }> = [];

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push(method);
    return { ok: false, error: `Unexpected IPC method ${method}` };
  },
  exitFromIpcResult: (r: { error?: string }) => {
    throw new Error(r.error ?? "IPC error");
  },
  exitCodeFromIpcResult: (r: { statusCode?: number }) =>
    r.statusCode === undefined ? 10 : r.statusCode >= 500 ? 3 : 1,
}));

mock.module("../../../../runtime/routes/oauth-commands-routes.js", () => ({
  handleRequest: async (args: { body: Record<string, unknown> }) => {
    handleRequestCalls.push(args);
    return {
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, user_id: "U0BOT" },
    };
  },
}));

import { Command } from "commander";

import { applyCommandHelp } from "../../../lib/cli-command-help.js";
import { channelsHelp } from "../index.help.js";
import {
  botProviderForChannel,
  registerChannelsRequestCommand,
  REQUESTABLE_CHANNELS,
} from "../request.js";

beforeEach(() => {
  ipcCalls.length = 0;
  handleRequestCalls.length = 0;
  process.exitCode = 0;
});

async function runChannelsRequest(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const program = new Command();
    program.exitOverride();
    const channels = program
      .command("channels")
      .description(channelsHelp.description);
    applyCommandHelp(channels, channelsHelp);
    registerChannelsRequestCommand(channels);
    const request = channels.commands.find((c) => c.name() === "request");
    request?.option("--json");
    await program.parseAsync(["node", "test", "channels", "request", ...args]);
  } catch {
    // Commander may throw under exitOverride for parse errors.
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return {
    stdout: out.join(""),
    stderr: err.join(""),
    exitCode: Number(process.exitCode ?? 0),
  };
}

describe("channel to bot provider", () => {
  test("names the bot credential's provider for every built-in bot channel", () => {
    // The map is the contract's, not a copy: the command answers exactly what
    // CHANNEL_BOT_PROVIDER says, including telegram, whose bot key carries no
    // suffix because Telegram has no user-identity integration.
    expect(botProviderForChannel("slack")).toBe("slack_channel");
    expect(botProviderForChannel("discord")).toBe("discord_channel");
    expect(botProviderForChannel("telegram")).toBe("telegram");
    expect([...REQUESTABLE_CHANNELS].sort()).toEqual([
      "discord",
      "slack",
      "telegram",
    ]);
  });

  test("a channel without a bot credential resolves to nothing", () => {
    expect(botProviderForChannel("phone")).toBeUndefined();
    expect(botProviderForChannel("vellum")).toBeUndefined();
    expect(botProviderForChannel("not-a-channel")).toBeUndefined();
  });

  test("an inherited object property is not a channel", () => {
    expect(botProviderForChannel("constructor")).toBeUndefined();
    expect(botProviderForChannel("toString")).toBeUndefined();
    expect(botProviderForChannel("__proto__")).toBeUndefined();
  });
});

describe("assistant channels request", () => {
  test("requests as the channel's bot, in-process, never over IPC", async () => {
    const { stdout, exitCode } = await runChannelsRequest([
      "slack",
      "-s",
      "/auth.test",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([]);
    expect(handleRequestCalls).toEqual([
      { body: { provider: "slack_channel", url: "/auth.test" } },
    ]);
    expect(stdout).toContain("U0BOT");
  });

  test("forwards method and JSON body the way oauth request does", async () => {
    await runChannelsRequest([
      "slack",
      "-s",
      "-X",
      "POST",
      "-d",
      '{"channel":"D0123456789","limit":20}',
      "/conversations.history",
    ]);

    expect(handleRequestCalls).toEqual([
      {
        body: {
          provider: "slack_channel",
          url: "/conversations.history",
          method: "POST",
          parsed_data: { channel: "D0123456789", limit: 20 },
        },
      },
    ]);
  });

  test("never offers the person's OAuth integration for a bot channel", async () => {
    await runChannelsRequest(["discord", "-s", "/users/@me"]);

    expect(handleRequestCalls[0]?.body.provider).toBe("discord_channel");
    expect(handleRequestCalls[0]?.body).not.toHaveProperty("account");
    expect(handleRequestCalls[0]?.body).not.toHaveProperty("client_id");
  });

  test("a channel with no bot credential is refused before any request", async () => {
    const { stderr, exitCode } = await runChannelsRequest([
      "phone",
      "/anything",
    ]);

    expect(exitCode).toBe(1);
    expect(handleRequestCalls).toEqual([]);
    expect(stderr).toContain('Channel "phone" has no bot credential');
    expect(stderr).toContain("plugins search");
  });

  test("names the channel command, not the OAuth one, in its diagnostics hint", async () => {
    mock.module("../../../../runtime/routes/oauth-commands-routes.js", () => ({
      handleRequest: async () => {
        throw new Error("boom");
      },
    }));

    const { stderr, exitCode } = await runChannelsRequest([
      "slack",
      "/auth.test",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("assistant channels get slack");
    expect(stderr).not.toContain("oauth providers get");
  });

  test("a structured route failure keeps the JSON envelope and the hint", async () => {
    const { RouteError } = await import("../../../../runtime/routes/errors.js");
    mock.module("../../../../runtime/routes/oauth-commands-routes.js", () => ({
      handleRequest: async () => {
        throw new RouteError(
          "Provider not configured: slack_channel",
          "NOT_FOUND",
          404,
        );
      },
    }));

    const { stdout, exitCode } = await runChannelsRequest([
      "slack",
      "--json",
      "/auth.test",
    ]);

    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("Provider not configured");
    expect(envelope.error).toContain("assistant channels get slack");
  });
});
