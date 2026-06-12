/**
 * Unit tests for AcpAgentProcess capability getters.
 *
 * The getters reflect the InitializeResponse captured during initialize();
 * before that resolves (or after kill()) they must report false. The
 * connection is stubbed directly so no child process is spawned.
 */

import { describe, expect, mock, test } from "bun:test";

import type { AuthMethod, InitializeResponse } from "@agentclientprotocol/sdk";

import { AcpAgentProcess } from "../agent-process.js";

function makeProcess(): AcpAgentProcess {
  return new AcpAgentProcess(
    "test-agent",
    { command: "echo", args: [] },
    () => {
      throw new Error("client factory should not be called in this test");
    },
  );
}

/** Injects a stub connection whose initialize() resolves with `response`. */
function stubConnection(
  proc: AcpAgentProcess,
  response: InitializeResponse,
): void {
  (
    proc as unknown as {
      connection: { initialize: () => Promise<InitializeResponse> };
    }
  ).connection = {
    initialize: () => Promise.resolve(response),
  };
}

describe("AcpAgentProcess capability getters", () => {
  test("both getters return false before initialize() resolves", () => {
    const proc = makeProcess();
    expect(proc.supportsLoadSession).toBe(false);
    expect(proc.supportsSessionResume).toBe(false);
  });

  test("supportsLoadSession reflects agentCapabilities.loadSession", async () => {
    const proc = makeProcess();
    stubConnection(proc, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });

    await proc.initialize();

    expect(proc.supportsLoadSession).toBe(true);
    expect(proc.supportsSessionResume).toBe(false);
  });

  test("supportsSessionResume reflects agentCapabilities.sessionCapabilities.resume", async () => {
    const proc = makeProcess();
    stubConnection(proc, {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    });

    await proc.initialize();

    expect(proc.supportsSessionResume).toBe(true);
    expect(proc.supportsLoadSession).toBe(false);
  });

  test("both getters return false when the agent advertises no capabilities", async () => {
    const proc = makeProcess();
    stubConnection(proc, { protocolVersion: 1 });

    await proc.initialize();

    expect(proc.supportsLoadSession).toBe(false);
    expect(proc.supportsSessionResume).toBe(false);
  });

  test("kill() clears the captured initialize response", async () => {
    const proc = makeProcess();
    stubConnection(proc, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
      },
    });

    await proc.initialize();
    expect(proc.supportsLoadSession).toBe(true);
    expect(proc.supportsSessionResume).toBe(true);

    proc.kill();

    expect(proc.supportsLoadSession).toBe(false);
    expect(proc.supportsSessionResume).toBe(false);
  });
});

describe("AcpAgentProcess loadSession/resumeSession", () => {
  /** Injects a stub connection that records loadSession/resumeSession params. */
  function stubSessionConnection(proc: AcpAgentProcess): {
    loadCalls: unknown[];
    resumeCalls: unknown[];
  } {
    const loadCalls: unknown[] = [];
    const resumeCalls: unknown[] = [];
    (proc as unknown as { connection: unknown }).connection = {
      loadSession: (params: unknown) => {
        loadCalls.push(params);
        return Promise.resolve({});
      },
      resumeSession: (params: unknown) => {
        resumeCalls.push(params);
        return Promise.resolve({});
      },
    };
    return { loadCalls, resumeCalls };
  }

  test("loadSession forwards { sessionId, cwd, mcpServers: [] } to the connection", async () => {
    const proc = makeProcess();
    const { loadCalls } = stubSessionConnection(proc);

    await proc.loadSession("session-1", "/tmp/project");

    expect(loadCalls).toEqual([
      { sessionId: "session-1", cwd: "/tmp/project", mcpServers: [] },
    ]);
  });

  test("resumeSession forwards { sessionId, cwd, mcpServers: [] } to the connection", async () => {
    const proc = makeProcess();
    const { resumeCalls } = stubSessionConnection(proc);

    await proc.resumeSession("session-2", "/tmp/project");

    expect(resumeCalls).toEqual([
      { sessionId: "session-2", cwd: "/tmp/project", mcpServers: [] },
    ]);
  });

  test("loadSession throws when the process is not spawned", async () => {
    const proc = makeProcess();

    await expect(proc.loadSession("session-1", "/tmp/project")).rejects.toThrow(
      'ACP agent "test-agent" is not spawned',
    );
  });

  test("resumeSession throws when the process is not spawned", async () => {
    const proc = makeProcess();

    await expect(
      proc.resumeSession("session-1", "/tmp/project"),
    ).rejects.toThrow('ACP agent "test-agent" is not spawned');
  });
});

describe("AcpAgentProcess auth_required retry", () => {
  // spawnedEnv is injected the way spawn() builds it ({ ...process.env,
  // ...config.env }), so the advertised var names use a VELLUM_TEST_ prefix
  // guaranteed absent from the test process env. The structure mirrors
  // codex-acp's real advertisement: an agent-driven browser login (no `type`,
  // must never be auto-selected) followed by two env_var methods, in that
  // order.
  const CODEX_VAR = "VELLUM_TEST_FAKE_CODEX_API_KEY";
  const OPENAI_VAR = "VELLUM_TEST_FAKE_OPENAI_API_KEY";

  const codexLikeAuthMethods: AuthMethod[] = [
    { id: "chatgpt", name: "Login with ChatGPT" },
    {
      type: "env_var",
      id: "codex-api-key",
      name: "Use CODEX_API_KEY",
      vars: [{ name: CODEX_VAR }],
    },
    {
      type: "env_var",
      id: "openai-api-key",
      name: "Use OPENAI_API_KEY",
      vars: [{ name: OPENAI_VAR }],
    },
  ];

  const authRequiredError = {
    code: -32000,
    message: "Authentication required",
  };

  /**
   * Creates a process whose connection is stubbed with mocks, then runs
   * initialize() so the advertised authMethods are captured.
   */
  async function setupAuthProcess(options: {
    env?: Record<string, string>;
    authMethods?: AuthMethod[];
    /** Rejections to throw from successive newSession calls before succeeding. */
    newSessionRejections?: unknown[];
    loadSessionRejections?: unknown[];
    resumeSessionRejections?: unknown[];
    promptRejections?: unknown[];
  }) {
    const proc = new AcpAgentProcess(
      "codex",
      { command: "echo", args: [], env: options.env },
      () => {
        throw new Error("client factory should not be called in this test");
      },
    );

    function failThenSucceed(rejections: unknown[], result: unknown) {
      let calls = 0;
      return mock(() => {
        const rejection = rejections[calls];
        calls += 1;
        return rejection != null
          ? Promise.reject(rejection)
          : Promise.resolve(result);
      });
    }

    const newSession = failThenSucceed(options.newSessionRejections ?? [], {
      sessionId: "session-1",
    });
    const loadSession = failThenSucceed(
      options.loadSessionRejections ?? [],
      {},
    );
    const resumeSession = failThenSucceed(
      options.resumeSessionRejections ?? [],
      {},
    );
    const prompt = failThenSucceed(options.promptRejections ?? [], {
      stopReason: "end_turn",
    });
    const authenticate = mock(() => Promise.resolve({}));

    const internals = proc as unknown as {
      connection: unknown;
      spawnedEnv: NodeJS.ProcessEnv;
    };
    internals.connection = {
      initialize: () =>
        Promise.resolve({
          protocolVersion: 1,
          authMethods: options.authMethods ?? codexLikeAuthMethods,
        }),
      newSession,
      loadSession,
      resumeSession,
      prompt,
      authenticate,
    };
    internals.spawnedEnv = { ...process.env, ...options.env };

    await proc.initialize();

    return {
      proc,
      newSession,
      loadSession,
      resumeSession,
      prompt,
      authenticate,
      internals,
    };
  }

  test("createSession does not authenticate when newSession succeeds", async () => {
    const { proc, newSession, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
    });

    const sessionId = await proc.createSession("/tmp/project");

    expect(sessionId).toBe("session-1");
    expect(newSession).toHaveBeenCalledTimes(1);
    expect(authenticate).not.toHaveBeenCalled();
  });

  test("auth_required with OPENAI-style key authenticates and retries once", async () => {
    const { proc, newSession, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      newSessionRejections: [authRequiredError],
    });

    const sessionId = await proc.createSession("/tmp/project");

    expect(sessionId).toBe("session-1");
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({ methodId: "openai-api-key" });
    expect(newSession).toHaveBeenCalledTimes(2);
  });

  test("auth_required with both keys present selects the earlier advertised method", async () => {
    // Both methods are satisfiable, so this pins advertised-order selection
    // rather than only-satisfiable selection.
    const { proc, authenticate } = await setupAuthProcess({
      env: { [CODEX_VAR]: "sk-codex", [OPENAI_VAR]: "sk-openai" },
      newSessionRejections: [authRequiredError],
    });

    await proc.createSession("/tmp/project");

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({ methodId: "codex-api-key" });
  });

  test("auth_required with no satisfiable env_var method throws an actionable error", async () => {
    const { proc, newSession, authenticate } = await setupAuthProcess({
      env: {},
      newSessionRejections: [authRequiredError],
    });

    const promise = proc.createSession("/tmp/project");

    await expect(promise).rejects.toThrow(
      'ACP agent "codex" requires authentication',
    );
    await expect(promise).rejects.toThrow("Login with ChatGPT");
    await expect(promise).rejects.toThrow(CODEX_VAR);
    await expect(promise).rejects.toThrow(OPENAI_VAR);
    expect(authenticate).not.toHaveBeenCalled();
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  test("a second auth_required after authenticating propagates without a retry loop", async () => {
    const { proc, newSession, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      newSessionRejections: [authRequiredError, authRequiredError],
    });

    await expect(proc.createSession("/tmp/project")).rejects.toMatchObject({
      code: -32000,
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(newSession).toHaveBeenCalledTimes(2);
  });

  test("an absent optional var does not block satisfiability", async () => {
    const { proc, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      authMethods: [
        {
          type: "env_var",
          id: "openai-api-key",
          name: "Use OPENAI_API_KEY",
          vars: [
            { name: OPENAI_VAR },
            { name: "VELLUM_TEST_FAKE_OPTIONAL_VAR", optional: true },
          ],
        },
      ],
      newSessionRejections: [authRequiredError],
    });

    await proc.createSession("/tmp/project");

    expect(authenticate).toHaveBeenCalledWith({ methodId: "openai-api-key" });
  });

  test("loadSession authenticates and retries on auth_required", async () => {
    const { proc, loadSession, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      loadSessionRejections: [authRequiredError],
    });

    await proc.loadSession("session-1", "/tmp/project");

    expect(authenticate).toHaveBeenCalledWith({ methodId: "openai-api-key" });
    expect(loadSession).toHaveBeenCalledTimes(2);
  });

  test("resumeSession authenticates and retries on auth_required", async () => {
    const { proc, resumeSession, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      resumeSessionRejections: [authRequiredError],
    });

    await proc.resumeSession("session-1", "/tmp/project");

    expect(authenticate).toHaveBeenCalledWith({ methodId: "openai-api-key" });
    expect(resumeSession).toHaveBeenCalledTimes(2);
  });

  test("prompt authenticates and retries on auth_required, returning the response", async () => {
    const { proc, prompt, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      promptRejections: [authRequiredError],
    });

    const response = await proc.prompt("session-1", "hello");

    expect(response).toEqual({ stopReason: "end_turn" });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({ methodId: "openai-api-key" });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  test("prompt auth_required with no satisfiable env_var method throws an actionable error", async () => {
    const { proc, prompt, authenticate } = await setupAuthProcess({
      env: {},
      promptRejections: [authRequiredError],
    });

    const promise = proc.prompt("session-1", "hello");

    await expect(promise).rejects.toThrow(
      'ACP agent "codex" requires authentication',
    );
    await expect(promise).rejects.toThrow("Login with ChatGPT");
    await expect(promise).rejects.toThrow(CODEX_VAR);
    await expect(promise).rejects.toThrow(OPENAI_VAR);
    expect(authenticate).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test("a non-auth error propagates without authenticating", async () => {
    const { proc, newSession, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      newSessionRejections: [{ code: -32603, message: "Internal error" }],
    });

    await expect(proc.createSession("/tmp/project")).rejects.toMatchObject({
      code: -32603,
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  test("auth_required after the agent process exits throws the not-spawned error", async () => {
    const { proc, authenticate, internals } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
    });

    // Simulate handleProcessExit racing the auth retry: the agent dies as it
    // rejects with auth_required, nulling the connection before the retry
    // path runs. spawnedEnv stays satisfiable so only the connection guard
    // can produce the failure.
    (internals.connection as { newSession: unknown }).newSession = () => {
      internals.connection = null;
      return Promise.reject(authRequiredError);
    };

    await expect(proc.createSession("/tmp/project")).rejects.toThrow(
      'ACP agent "codex" is not spawned',
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  test("satisfiability uses the env captured at spawn, not live process.env", async () => {
    const { proc, authenticate } = await setupAuthProcess({
      env: { [OPENAI_VAR]: "sk-test" },
      newSessionRejections: [authRequiredError],
    });

    // Drift process.env after "spawn": the earlier-advertised codex var
    // appears, but the spawned child never saw it, so the openai method
    // must still be selected.
    process.env[CODEX_VAR] = "sk-codex-late";
    try {
      await proc.createSession("/tmp/project");
    } finally {
      delete process.env[CODEX_VAR];
    }

    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({ methodId: "openai-api-key" });
  });
});
