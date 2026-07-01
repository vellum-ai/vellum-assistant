import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

type IpcCall = {
  method: string;
  params?: Record<string, unknown>;
};

type GatewayCall = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
};

type SlackReplyCall = {
  chatId: string;
  text: string;
  options?: Record<string, unknown>;
};

type MockBinding = {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
  externalThreadId?: string | null;
  createdAt: number;
  updatedAt: number;
};

const cliIpcCalls: IpcCall[] = [];
const gatewayCalls: GatewayCall[] = [];
const slackReplyCalls: SlackReplyCall[] = [];
const bindingCalls: string[] = [];

let cliIpcResponse: {
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
} = { ok: true, result: {} };
let gatewayResponse: unknown = {
  detached: true,
  channelId: "C123",
  threadTs: "1700000000.000100",
};
let slackReplyError: Error | null = null;
let mockBinding: MockBinding | null = null;

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    cliIpcCalls.push({ method, params });
    return cliIpcResponse;
  },
  cliIpcCallBinary: async () => cliIpcResponse,
  cliIpcCallStream: async () => cliIpcResponse,
  exitFromIpcResult: (result: { error?: string; statusCode?: number }) => {
    process.stderr.write((result.error ?? "Unknown error") + "\n");
    process.exitCode = exitCodeFromIpcResult(result);
  },
  exitCodeFromIpcResult,
}));

function exitCodeFromIpcResult(result: { statusCode?: number }): number {
  if (result.statusCode === undefined) return 10;
  if (result.statusCode >= 500) return 3;
  if (result.statusCode >= 400) return 2;
  return 1;
}

mock.module("../../../ipc/gateway-client.js", () => ({
  ipcCall: async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    gatewayCalls.push({ method, params, timeoutMs });
    return gatewayResponse;
  },
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    gatewayCalls.push({ method, params, timeoutMs });
    return gatewayResponse;
  },
  resetPersistentClient: () => {},
  ipcGetFeatureFlags: async () => ({}),
  ipcGetVelayStatus: async () => null,
  ipcClassifyRisk: async () => ({ risk: "low" }),
}));

mock.module("../../../messaging/providers/slack/send.js", () => ({
  sendSlackReply: async (
    chatId: string,
    text: string,
    options?: Record<string, unknown>,
  ) => {
    slackReplyCalls.push({ chatId, text, options });
    if (slackReplyError) throw slackReplyError;
    return { ok: true, ts: "1700000000.000200" };
  },
  sendSlackStreamOp: async () => ({ ok: true, ts: "1700000000.000200" }),
  sendSlackReaction: async () => {},
  sendSlackAssistantThreadStatus: async () => {},
  sendSlackAttachments: async () => ({
    allFailed: false,
    failureCount: 0,
  }),
}));

mock.module("../../../persistence/external-conversation-store.js", () => ({
  upsertBinding: () => {},
  upsertOutboundBinding: () => {},
  updateExternalChatName: () => {},
  getBindingByConversation: (conversationId: string) => {
    bindingCalls.push(conversationId);
    return mockBinding;
  },
  getBindingByChannelChat: () => null,
  getBindingByChannelChatThread: () => null,
  deleteBindingByChannelChat: () => {},
  deleteBindingByChannelChatThread: () => {},
  getBindingsForConversations: () => new Map(),
}));

mock.module("../../../util/logger.js", () => ({
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
  initLogger: () => {},
  truncateForLog: (value: string) => value,
  pruneOldLogFiles: () => 0,
  LOG_FILE_PATTERN: /^assistant-(\d{4}-\d{2}-\d{2})\.log$/,
  getCurrentLogFilePath: () => "/tmp/test-assistant.log",
}));

const { registerConversationsCommand } = await import("../conversations.js");
const { ROUTES: CONVERSATION_CLI_ROUTES } =
  await import("../../../runtime/routes/conversation-cli-routes.js");

const slackDetachRouteCandidate = CONVERSATION_CLI_ROUTES.find(
  (route) => route.operationId === "conversation_slack_detach_cli",
);

if (!slackDetachRouteCandidate) {
  throw new Error("conversation_slack_detach_cli route not registered");
}
const slackDetachRoute = slackDetachRouteCandidate;

let savedConvId: string | undefined;
let savedSkillContext: string | undefined;

beforeEach(() => {
  cliIpcCalls.length = 0;
  gatewayCalls.length = 0;
  slackReplyCalls.length = 0;
  bindingCalls.length = 0;
  cliIpcResponse = { ok: true, result: {} };
  gatewayResponse = {
    detached: true,
    channelId: "C123",
    threadTs: "1700000000.000100",
  };
  slackReplyError = null;
  mockBinding = null;
  process.exitCode = 0;

  savedConvId = process.env.__CONVERSATION_ID;
  savedSkillContext = process.env.__SKILL_CONTEXT_JSON;
  delete process.env.__CONVERSATION_ID;
  delete process.env.__SKILL_CONTEXT_JSON;
});

afterEach(() => {
  if (savedConvId !== undefined) {
    process.env.__CONVERSATION_ID = savedConvId;
  } else {
    delete process.env.__CONVERSATION_ID;
  }

  if (savedSkillContext !== undefined) {
    process.env.__SKILL_CONTEXT_JSON = savedSkillContext;
  } else {
    delete process.env.__SKILL_CONTEXT_JSON;
  }

  process.exitCode = 0;
});

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerConversationsCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

async function callSlackDetachRoute(body: Record<string, unknown>) {
  return slackDetachRoute.handler({ body });
}

function makeBinding(overrides: Partial<MockBinding> = {}): MockBinding {
  return {
    conversationId: "conv-1",
    sourceChannel: "slack",
    externalChatId: "C123",
    externalThreadId: "1700000000.000100",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function expectRouteError(
  body: Record<string, unknown>,
  code: string,
): Promise<void> {
  try {
    await callSlackDetachRoute(body);
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected route error ${code}`);
}

describe("conversation_slack_detach_cli route", () => {
  test("detaches by explicit Slack identifiers without loading a binding", async () => {
    const result = await callSlackDetachRoute({
      channelId: "C123",
      threadTs: "1700000000.000100",
    });

    expect(result).toEqual({
      detached: true,
      channelId: "C123",
      threadTs: "1700000000.000100",
      source: "explicit",
    });
    expect(bindingCalls).toHaveLength(0);
    expect(gatewayCalls).toEqual([
      {
        method: "detach_slack_active_thread",
        params: {
          channelId: "C123",
          threadTs: "1700000000.000100",
        },
        timeoutMs: 5000,
      },
    ]);
    expect(slackReplyCalls).toEqual([
      {
        chatId: "C123",
        text: "Muted this Slack thread. I won't respond to further replies here unless you mention me again.",
        options: { threadTs: "1700000000.000100" },
      },
    ]);
  });

  test("resolves Slack identifiers from a conversation binding", async () => {
    mockBinding = makeBinding();

    const result = await callSlackDetachRoute({ conversationId: "conv-1" });

    expect(result).toEqual({
      detached: true,
      channelId: "C123",
      threadTs: "1700000000.000100",
      source: "conversation_binding",
      conversationId: "conv-1",
    });
    expect(bindingCalls).toEqual(["conv-1"]);
    expect(gatewayCalls[0]).toMatchObject({
      method: "detach_slack_active_thread",
      params: {
        channelId: "C123",
        threadTs: "1700000000.000100",
      },
    });
    expect(slackReplyCalls).toEqual([
      {
        chatId: "C123",
        text: "Muted this Slack thread. I won't respond to further replies here unless you mention me again.",
        options: { threadTs: "1700000000.000100" },
      },
    ]);
  });

  test("does not send a confirmation when the gateway reports no detach", async () => {
    gatewayResponse = {
      detached: false,
      channelId: "C123",
      threadTs: "1700000000.000100",
    };

    const result = await callSlackDetachRoute({
      channelId: "C123",
      threadTs: "1700000000.000100",
    });

    expect(result).toMatchObject({ detached: false });
    expect(slackReplyCalls).toHaveLength(0);
  });

  test("returns NOT_FOUND when no conversation binding exists", async () => {
    await expectRouteError({ conversationId: "conv-missing" }, "NOT_FOUND");
    expect(gatewayCalls).toHaveLength(0);
  });

  test("rejects non-Slack conversation bindings", async () => {
    mockBinding = makeBinding({ sourceChannel: "telegram" });

    await expectRouteError({ conversationId: "conv-1" }, "BAD_REQUEST");
    expect(gatewayCalls).toHaveLength(0);
  });

  test("rejects Slack bindings that are not thread-bound", async () => {
    mockBinding = makeBinding({ externalThreadId: null });

    await expectRouteError({ conversationId: "conv-1" }, "BAD_REQUEST");
    expect(gatewayCalls).toHaveLength(0);
  });

  test("rejects malformed gateway responses", async () => {
    gatewayResponse = { detached: true };

    await expectRouteError(
      { channelId: "C123", threadTs: "1700000000.000100" },
      "BAD_GATEWAY",
    );
    expect(slackReplyCalls).toHaveLength(0);
  });

  test("reports a gateway error when the confirmation message cannot be sent", async () => {
    slackReplyError = new Error("Slack bot token not configured");

    await expectRouteError(
      { channelId: "C123", threadTs: "1700000000.000100" },
      "BAD_GATEWAY",
    );
    expect(gatewayCalls).toHaveLength(1);
    expect(slackReplyCalls).toHaveLength(1);
  });
});

describe("assistant conversations slack detach", () => {
  test("detaches with explicit Slack identifiers", async () => {
    cliIpcResponse = {
      ok: true,
      result: {
        detached: true,
        channelId: "C123",
        threadTs: "1700000000.000100",
        source: "explicit",
      },
    };

    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "detach",
      "--channel",
      "C123",
      "--thread",
      "1700000000.000100",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      result: {
        detached: true,
        channelId: "C123",
        threadTs: "1700000000.000100",
        source: "explicit",
      },
    });
    expect(cliIpcCalls).toEqual([
      {
        method: "conversation_slack_detach_cli",
        params: {
          body: {
            channelId: "C123",
            threadTs: "1700000000.000100",
          },
        },
      },
    ]);
  });

  test("defaults to the current conversation when no Slack identifiers are provided", async () => {
    process.env.__CONVERSATION_ID = "conv-env";
    cliIpcResponse = {
      ok: true,
      result: {
        detached: true,
        channelId: "C123",
        threadTs: "1700000000.000100",
        source: "conversation_binding",
        conversationId: "conv-env",
      },
    };

    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "detach",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).result.conversationId).toBe("conv-env");
    expect(cliIpcCalls[0]).toEqual({
      method: "conversation_slack_detach_cli",
      params: { body: { conversationId: "conv-env" } },
    });
  });

  test("supports mute as an alias for detach", async () => {
    cliIpcResponse = {
      ok: true,
      result: {
        detached: false,
        channelId: "C123",
        threadTs: "1700000000.000100",
        source: "explicit",
      },
    };

    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "mute",
      "--channel",
      "C123",
      "--thread",
      "1700000000.000100",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).result.detached).toBe(false);
    expect(cliIpcCalls[0].method).toBe("conversation_slack_detach_cli");
  });

  test("fails locally when no target can be resolved", async () => {
    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "detach",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
    expect(cliIpcCalls).toHaveLength(0);
  });

  test("fails locally when only one explicit Slack identifier is provided", async () => {
    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "detach",
      "--channel",
      "C123",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("--channel");
    expect(parsed.error).toContain("--thread");
    expect(cliIpcCalls).toHaveLength(0);
  });

  test("fails locally when explicit Slack identifiers are empty", async () => {
    process.env.__CONVERSATION_ID = "conv-env";

    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "detach",
      "--channel",
      "",
      "--thread",
      "   ",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("--channel");
    expect(parsed.error).toContain("--thread");
    expect(cliIpcCalls).toHaveLength(0);
  });

  test("maps JSON IPC transport errors to the shared exit code", async () => {
    cliIpcResponse = {
      ok: false,
      error: "Could not connect to assistant",
    };

    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "detach",
      "--channel",
      "C123",
      "--thread",
      "1700000000.000100",
      "--json",
    ]);

    expect(exitCode).toBe(10);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "Could not connect to assistant",
    });
    expect(cliIpcCalls).toHaveLength(1);
  });

  test("maps JSON IPC 4xx errors to the shared exit code", async () => {
    cliIpcResponse = {
      ok: false,
      error: "Conversation is not bound to a Slack thread",
      statusCode: 400,
    };

    const { stdout, exitCode } = await runCommand([
      "conversations",
      "slack",
      "detach",
      "conv-1",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: "Conversation is not bound to a Slack thread",
    });
    expect(cliIpcCalls).toHaveLength(1);
  });
});
