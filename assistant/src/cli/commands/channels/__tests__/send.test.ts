import { beforeEach, describe, expect, mock, test } from "bun:test";

// The command is a door onto the daemon's one send implementation, so what
// matters is the request it hands the route and what it does with the
// answer. IPC is stubbed to capture that request; the exit-code helper
// stays real, so the tests assert the mapping that ships.

const ipcCalls: Array<{
  method: string;
  params: Record<string, unknown>;
  opts?: Record<string, unknown>;
}> = [];
let ipcResult: Record<string, unknown> = {
  ok: true,
  result: {
    channel: "slack",
    chatId: "C0123456789",
    messageIds: ["1700000000.000100"],
    lastMessageId: "1700000000.000100",
    recordedIn: "conv-home",
  },
};

const actualCliClient = await import("../../../../ipc/cli-client.js");
mock.module("../../../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: async (
    method: string,
    params: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => {
    ipcCalls.push({ method, params, ...(opts ? { opts } : {}) });
    return ipcResult;
  },
}));

// Imported after the mock is installed, so the command module under test
// binds the stubbed IPC call rather than the real one.
const { runCliCommand } = await import("../../__tests__/cli-test-harness.js");
const { registerChannelsCommand } = await import("../index.js");

beforeEach(() => {
  ipcCalls.length = 0;
  ipcResult = {
    ok: true,
    result: {
      channel: "slack",
      chatId: "C0123456789",
      messageIds: ["1700000000.000100"],
      lastMessageId: "1700000000.000100",
      recordedIn: "conv-home",
    },
  };
});

// The shipped registration as-is: `send` declares its own `--json`, which is
// why the program's global leaf-option pass skips it.
function runSend(args: string[]) {
  return runCliCommand(registerChannelsCommand, ["channels", "send", ...args]);
}

/** The body the command handed the route on its one call. */
function sentBody(): Record<string, unknown> {
  expect(ipcCalls).toHaveLength(1);
  expect(ipcCalls[0]!.method).toBe("channels_send_post");
  return ipcCalls[0]!.params.body as Record<string, unknown>;
}

describe("the request the command makes", () => {
  test("names the chat and asks for the channel's rich rendering", async () => {
    const r = await runSend([
      "slack",
      "C0123456789",
      "--text",
      "deploy is green",
    ]);
    expect(r.exitCode).toBe(0);
    expect(sentBody()).toEqual({
      channel: "slack",
      target: { kind: "chat", chatId: "C0123456789" },
      text: "deploy is green",
      renderRichly: true,
    });
  });

  test("carries a named thread as the target's thread", async () => {
    await runSend([
      "slack",
      "C0123456789",
      "--thread",
      "1700000000.000001",
      "--text",
      "and the smoke tests passed",
    ]);
    expect(sentBody().target).toEqual({
      kind: "chat",
      chatId: "C0123456789",
      threadId: "1700000000.000001",
    });
  });

  test("--plain asks for the text verbatim", async () => {
    await runSend(["telegram", "123456789", "--text", "morning", "--plain"]);
    const body = sentBody();
    expect(body.renderRichly).toBeUndefined();
    expect(body.channel).toBe("telegram");
  });

  test("sends the text as the caller wrote it, whitespace included", async () => {
    await runSend([
      "slack",
      "C0123456789",
      "--text",
      "  indented  ",
      "--plain",
    ]);
    expect(sentBody().text).toBe("  indented  ");
  });

  test("waits longer than the IPC default, since the send itself retries", async () => {
    await runSend(["slack", "C0123456789", "--text", "hi"]);
    expect(ipcCalls[0]!.opts).toMatchObject({ timeoutMs: 120_000 });
  });

  test("refuses an empty text before it sends anything", async () => {
    for (const args of [
      ["slack", "C0123456789"],
      ["slack", "C0123456789", "--text", "   "],
    ]) {
      ipcCalls.length = 0;
      const r = await runSend(args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--text is required");
      expect(ipcCalls).toEqual([]);
    }
  });
});

describe("what the command reports", () => {
  test("names where the post landed and the conversation it was recorded in", async () => {
    const r = await runSend(["slack", "C0123456789", "--text", "hello"]);
    expect(r.stdout).toContain("C0123456789");
    expect(r.stdout).toContain("1700000000.000100");
    expect(r.stdout).toContain("conv-home");
  });

  test("says so when the channel split the text", async () => {
    ipcResult = {
      ok: true,
      result: {
        channel: "telegram",
        chatId: "123456789",
        messageIds: ["10", "11", "12"],
        lastMessageId: "12",
      },
    };
    const r = await runSend(["telegram", "123456789", "--text", "a long one"]);
    expect(r.stdout).toContain("3 posts");
  });

  test("--json answers with the route's own result", async () => {
    const r = await runSend([
      "slack",
      "C0123456789",
      "--text",
      "hello",
      "--json",
    ]);
    expect(JSON.parse(r.stdout)).toEqual({
      channel: "slack",
      chatId: "C0123456789",
      messageIds: ["1700000000.000100"],
      lastMessageId: "1700000000.000100",
      recordedIn: "conv-home",
    });
  });

  test("a refused send reports the route's reason and its exit code", async () => {
    ipcResult = {
      ok: false,
      error: 'Channel "email" is not addressable',
      statusCode: 400,
    };
    const r = await runSend(["email", "someone", "--text", "hello"]);
    expect(r.exitCode).toBe(
      actualCliClient.exitCodeFromIpcResult({ statusCode: 400 }),
    );
    expect(r.stderr).toContain("not addressable");
  });

  test("a timeout is reported as an unknown outcome, not a failure to retry", async () => {
    ipcResult = { ok: false, error: "Request timed out", timedOut: true };
    const r = await runSend(["slack", "C0123456789", "--text", "hello"]);
    expect(r.stderr).toContain("may still be in flight");
    expect(r.stderr).toContain("before sending again");
    expect(r.stderr).not.toContain("The send failed");
  });

  test("a refusal in --json mode is a JSON error envelope", async () => {
    ipcResult = {
      ok: false,
      error: 'Channel "slack" did not acknowledge the send',
      statusCode: 502,
    };
    const r = await runSend([
      "slack",
      "C0123456789",
      "--text",
      "hello",
      "--json",
    ]);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: false,
      error: 'Channel "slack" did not acknowledge the send',
    });
    expect(r.exitCode).toBe(3);
  });
});
