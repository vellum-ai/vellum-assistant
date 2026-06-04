import type { ChildProcess } from "node:child_process";
import * as nodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  CreateTerminalRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import type { ServerMessage } from "../../daemon/message-protocol.js";

// Capture the env every `spawn()` is called with so the terminal-env tests can
// assert what the child process would inherit, without launching a real
// process. Each spawn returns an inert fake ChildProcess.
const spawnEnvCalls: (Record<string, string> | undefined)[] = [];

// Preserve every real `node:child_process` export (execFile, exec, fork, …)
// that other modules in the import graph rely on; only override `spawn`.
mock.module("node:child_process", () => ({
  ...nodeChildProcess,
  spawn: (
    _command: string,
    _args: string[],
    options: { env?: Record<string, string> },
  ): ChildProcess => {
    spawnEnvCalls.push(options.env);
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    } as unknown as ChildProcess;
  },
}));

const { VellumAcpClientHandler } = await import("../client-handler.js");
type VellumAcpClientHandler = InstanceType<typeof VellumAcpClientHandler>;

const ACP_SESSION_ID = "acp-session-abc";
const PARENT_CONVERSATION_ID = "conv-xyz";

function makeHandler(injectedAgentEnv?: Record<string, string>): {
  handler: VellumAcpClientHandler;
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  const handler = new VellumAcpClientHandler(
    ACP_SESSION_ID,
    (msg) => {
      sent.push(msg);
    },
    PARENT_CONVERSATION_ID,
    injectedAgentEnv,
  );
  return { handler, sent };
}

describe("VellumAcpClientHandler.sessionUpdate", () => {
  test("forwards agent_thought_chunk as an acp_session_update", async () => {
    const { handler, sent } = makeHandler();

    const notification: SessionNotification = {
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "internal reasoning here" },
      },
    };

    await handler.sessionUpdate(notification);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "acp_session_update",
      acpSessionId: ACP_SESSION_ID,
      updateType: "agent_thought_chunk",
      content: "internal reasoning here",
    });
  });

  test("agent_thought_chunk does not contribute to accumulated response text", async () => {
    const { handler } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      },
    });

    // Thoughts are forwarded for UI display but should not be treated as the
    // agent's final response text.
    expect(handler.responseText).toBe("");
  });
});

describe("VellumAcpClientHandler.createTerminal — env sanitization", () => {
  // Daemon secrets + control-plane reachability vars an untrusted ACP agent
  // must NOT be able to recover by running `env` (or curling the internal
  // gateway/CES) in a terminal. Stubbed onto process.env so the test proves
  // they are stripped rather than forwarded.
  const DAEMON_ONLY_ENV = {
    CES_SERVICE_TOKEN: "daemon-ces-token",
    ACTOR_TOKEN_SIGNING_KEY: "daemon-signing-key",
    GATEWAY_INTERNAL_URL: "http://internal-gateway:9999",
  } as const;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    spawnEnvCalls.length = 0;
    for (const [key, value] of Object.entries(DAEMON_ONLY_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    // PATH must be present so buildAgentSpawnEnv's allowlist base has something
    // real to forward.
    savedEnv.PATH = process.env.PATH;
    process.env.PATH = process.env.PATH ?? "/usr/bin";
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key]!;
    }
  });

  async function spawnTerminal(
    handler: VellumAcpClientHandler,
    params: Partial<CreateTerminalRequest> = {},
  ): Promise<Record<string, string>> {
    await handler.createTerminal({
      sessionId: ACP_SESSION_ID,
      command: "env",
      ...params,
    } as CreateTerminalRequest);
    const env = spawnEnvCalls.at(-1);
    expect(env).toBeDefined();
    return env!;
  }

  test("strips daemon secrets and control-plane vars from the terminal env", async () => {
    const { handler } = makeHandler();

    const env = await spawnTerminal(handler);

    // The side-channel that defeated the adapter env strip: none of these may
    // reach a terminal the agent launches.
    expect(env.CES_SERVICE_TOKEN).toBeUndefined();
    expect(env.ACTOR_TOKEN_SIGNING_KEY).toBeUndefined();
    expect(env.GATEWAY_INTERNAL_URL).toBeUndefined();
    expect(env.INTERNAL_GATEWAY_BASE_URL).toBeUndefined();
    // Allowlisted base vars still pass through so binaries resolve.
    expect(env.PATH).toBeDefined();
  });

  test("forwards the agent's injected credentials to the terminal", async () => {
    const { handler } = makeHandler({
      OPENAI_API_KEY: "agent-openai-key",
      GH_TOKEN: "agent-gh-token",
    });

    const env = await spawnTerminal(handler);

    // The agent's own scoped creds (git/LLM auth) survive so terminals work.
    expect(env.OPENAI_API_KEY).toBe("agent-openai-key");
    expect(env.GH_TOKEN).toBe("agent-gh-token");
    // But the daemon secrets are still gone.
    expect(env.CES_SERVICE_TOKEN).toBeUndefined();
  });

  test("applies params.env but cannot reintroduce a stripped control-plane var", async () => {
    const { handler } = makeHandler();

    const env = await spawnTerminal(handler, {
      env: [
        { name: "MY_TERMINAL_VAR", value: "hello" },
        // The agent tries to smuggle a stripped control-plane var back in via
        // params.env — the post-merge strip must still remove it.
        { name: "GATEWAY_INTERNAL_URL", value: "http://attacker" },
      ],
    });

    expect(env.MY_TERMINAL_VAR).toBe("hello");
    expect(env.GATEWAY_INTERNAL_URL).toBeUndefined();
  });
});
