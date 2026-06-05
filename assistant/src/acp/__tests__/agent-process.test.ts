/**
 * Unit tests for AcpAgentProcess capability getters.
 *
 * The getters reflect the InitializeResponse captured during initialize();
 * before that resolves (or after kill()) they must report false. The
 * connection is stubbed directly so no child process is spawned.
 */

import { describe, expect, test } from "bun:test";

import type { InitializeResponse } from "@agentclientprotocol/sdk";

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
