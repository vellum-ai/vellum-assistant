/**
 * Tests for the gateway → assistant reverse IPC client.
 *
 * Uses a real in-process socket server (net.createServer) rather than mocking
 * net.connect, because mocking the net module is very tricky in bun.
 *
 * Each test creates a unique workspace directory so that resolveIpcSocketPath
 * produces a socket path that matches our in-process server.
 */

import { mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  IpcHandlerError,
  IpcTransportError,
  ipcCallAssistant,
  ipcSuggestTrustRule,
} from "./assistant-client.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let server: Server | undefined;
let origWorkspaceDir: string | undefined;
let origAssistantIpcDir: string | undefined;

// Save and restore VELLUM_WORKSPACE_DIR + ASSISTANT_IPC_SOCKET_DIR around
// each test. The sandbox sets ASSISTANT_IPC_SOCKET_DIR, which would
// otherwise win over VELLUM_WORKSPACE_DIR in `resolveIpcSocketPath` and
// route requests to the real daemon socket instead of our test server.
beforeEach(() => {
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  origAssistantIpcDir = process.env.ASSISTANT_IPC_SOCKET_DIR;
  delete process.env.ASSISTANT_IPC_SOCKET_DIR;
  server = undefined;
});

afterEach(async () => {
  if (origWorkspaceDir !== undefined) {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  } else {
    delete process.env.VELLUM_WORKSPACE_DIR;
  }

  if (origAssistantIpcDir !== undefined) {
    process.env.ASSISTANT_IPC_SOCKET_DIR = origAssistantIpcDir;
  } else {
    delete process.env.ASSISTANT_IPC_SOCKET_DIR;
  }

  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = undefined;
  }
});

/**
 * Create a fresh temp workspace dir, configure VELLUM_WORKSPACE_DIR to point
 * at it, and return the socket path that ipcCallAssistant will connect to.
 *
 * resolveIpcSocketPath("assistant") = join(workspaceDir, "assistant.sock")
 * when the path fits within the Unix socket path limit (which a short tmpdir
 * path always does).
 */
function setupWorkspace(): string {
  const dir = join(
    tmpdir(),
    `vellum-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  process.env.VELLUM_WORKSPACE_DIR = dir;
  return join(dir, "assistant.sock");
}

/** Send a success NDJSON response over the socket. */
function sendResult(socket: Socket, id: string, result: unknown): void {
  socket.write(JSON.stringify({ id, result }) + "\n");
}

/** Send an error NDJSON response over the socket. */
function sendError(socket: Socket, id: string, error: string): void {
  socket.write(JSON.stringify({ id, error }) + "\n");
}

/** Send a handler-level error (with statusCode) over the socket. */
function sendHandlerError(
  socket: Socket,
  id: string,
  error: string,
  statusCode: number,
  errorCode: string,
): void {
  socket.write(
    JSON.stringify({ id, error, statusCode, errorCode }) + "\n",
  );
}

/**
 * Start an in-process NDJSON server that reads one request and calls
 * `handler` with the parsed method, params, and socket.
 */
async function startServer(
  sockPath: string,
  handler: (
    id: string,
    method: string,
    params: Record<string, unknown> | undefined,
    socket: Socket,
  ) => void,
): Promise<void> {
  server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buf.slice(0, newlineIdx).trim();
      buf = buf.slice(newlineIdx + 1);
      if (!line) return;
      try {
        const msg = JSON.parse(line) as {
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };
        handler(msg.id, msg.method, msg.params, socket);
      } catch {
        // Ignore malformed
      }
    });
  });

  return new Promise((resolve, reject) => {
    server!.listen(sockPath, () => resolve());
    server!.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// ipcCallAssistant tests
// ---------------------------------------------------------------------------

describe("ipcCallAssistant", () => {
  test("resolves with the result field from the NDJSON response", async () => {
    const sockPath = setupWorkspace();
    const expectedResult = { foo: "bar", count: 42 };

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, expectedResult);
      socket.end();
    });

    const result = await ipcCallAssistant("test_method", { a: 1 });
    expect(result).toEqual(expectedResult);
  });

  test("throws IpcTransportError when the socket does not exist", async () => {
    setupWorkspace();
    // No server started — socket file does not exist
    await expect(ipcCallAssistant("test_method")).rejects.toBeInstanceOf(
      IpcTransportError,
    );
  });

  test("throws IpcTransportError when server returns an error without statusCode", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendError(socket, id, "something went wrong");
      socket.end();
    });

    await expect(ipcCallAssistant("failing_method")).rejects.toBeInstanceOf(
      IpcTransportError,
    );
  });

  test("throws IpcHandlerError when server returns error with statusCode", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendHandlerError(socket, id, "Not found", 404, "NOT_FOUND");
      socket.end();
    });

    const promise = ipcCallAssistant("failing_method");
    await expect(promise).rejects.toBeInstanceOf(IpcHandlerError);
    try {
      await promise;
    } catch (err) {
      const handlerErr = err as IpcHandlerError;
      expect(handlerErr.message).toBe("Not found");
      expect(handlerErr.statusCode).toBe(404);
      expect(handlerErr.code).toBe("NOT_FOUND");
    }
  });

  test("passes method and params to the server", async () => {
    const sockPath = setupWorkspace();
    let receivedMethod: string | undefined;
    let receivedParams: Record<string, unknown> | undefined;

    await startServer(sockPath, (id, method, params, socket) => {
      receivedMethod = method;
      receivedParams = params;
      sendResult(socket, id, { ok: true });
      socket.end();
    });

    await ipcCallAssistant("my_method", { x: 1, y: "hello" });
    expect(receivedMethod).toBe("my_method");
    expect(receivedParams).toEqual({ x: 1, y: "hello" });
  });
});

// ---------------------------------------------------------------------------
// ipcSuggestTrustRule tests
// ---------------------------------------------------------------------------

const validRequest = {
  tool: "bash",
  command: "git push --force",
  riskAssessment: {
    risk: "high",
    reasoning: "Force push can overwrite remote history",
    reasonDescription: "Force operations",
  },
  scopeOptions: [
    { pattern: "git push --force", label: "git push --force" },
    { pattern: "git push *", label: "git push *" },
  ],
  currentThreshold: "medium",
  intent: "auto_approve" as const,
};

const validResponse = {
  pattern: "git push --force origin main",
  risk: "high",
  scope: "/workspace/*",
  description: "Allow force push to origin main in workspace",
  scopeOptions: [{ pattern: "git push --force", label: "git push --force" }],
};

describe("ipcSuggestTrustRule", () => {
  test("returns typed response when server returns a valid object", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, validResponse);
      socket.end();
    });

    const result = await ipcSuggestTrustRule(validRequest);
    expect(result.pattern).toBe(validResponse.pattern);
    expect(result.risk).toBe(validResponse.risk);
    expect(result.scope).toBe(validResponse.scope);
    expect(result.description).toBe(validResponse.description);
    expect(result.scopeOptions).toEqual(validResponse.scopeOptions);
  });

  test("sends suggest_trust_rule as the method name", async () => {
    const sockPath = setupWorkspace();
    let receivedMethod: string | undefined;

    await startServer(sockPath, (id, method, _params, socket) => {
      receivedMethod = method;
      sendResult(socket, id, validResponse);
      socket.end();
    });

    await ipcSuggestTrustRule(validRequest);
    expect(receivedMethod).toBe("suggest_trust_rule");
  });

  test("propagates IpcTransportError when the assistant returns an error field", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendError(socket, id, "LLM call failed");
      socket.end();
    });

    await expect(ipcSuggestTrustRule(validRequest)).rejects.toBeInstanceOf(
      IpcTransportError,
    );
  });

  test("throws when the response is null", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, null);
      socket.end();
    });

    await expect(ipcSuggestTrustRule(validRequest)).rejects.toThrow(
      "ipcSuggestTrustRule: unexpected response shape",
    );
  });

  test("throws when the response is an array", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, [1, 2, 3]);
      socket.end();
    });

    await expect(ipcSuggestTrustRule(validRequest)).rejects.toThrow(
      "ipcSuggestTrustRule: unexpected response shape",
    );
  });

  test("throws when the response is a string", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, "some string");
      socket.end();
    });

    await expect(ipcSuggestTrustRule(validRequest)).rejects.toThrow(
      "ipcSuggestTrustRule: unexpected response shape",
    );
  });

  test("propagates IpcTransportError when the socket is unavailable", async () => {
    setupWorkspace();
    // No server — socket does not exist, ipcCallAssistant throws IpcTransportError.

    await expect(ipcSuggestTrustRule(validRequest)).rejects.toBeInstanceOf(
      IpcTransportError,
    );
  });
});
