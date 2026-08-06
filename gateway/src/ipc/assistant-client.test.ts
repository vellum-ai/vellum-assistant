/**
 * Tests for the gateway → assistant reverse IPC client.
 *
 * Uses a real in-process socket server (net.createServer) rather than mocking
 * net.connect, because mocking the net module is very tricky in bun. The test
 * server speaks the same length-prefixed framing the daemon does, via the
 * shared reader/writer, so the wire format is exercised rather than imitated.
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
  IpcFrameReader,
  writeMessage,
  writeStreamChunk,
  writeStreamEnd,
} from "@vellumai/ipc-server-utils";

import {
  IpcHandlerError,
  IpcTransportError,
  ipcCallAssistant,
  ipcCallAssistantRaw,
  ipcSuggestTrustRule,
} from "./assistant-client.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let server: Server | undefined;
/** Binary frame the test server received alongside the last request. */
let lastRequestBinary: Uint8Array | undefined;
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
  lastRequestBinary = undefined;
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

/** Send a success response over the socket. */
function sendResult(socket: Socket, id: string, result: unknown): void {
  writeMessage(socket, { id, result });
}

/** Send an error response over the socket. */
function sendError(socket: Socket, id: string, error: string): void {
  writeMessage(socket, { id, error });
}

/** Send a handler-level error (with statusCode) over the socket. */
function sendHandlerError(
  socket: Socket,
  id: string,
  error: string,
  statusCode: number,
  errorCode: string,
): void {
  writeMessage(socket, { id, error, statusCode, errorCode } as never);
}

/** Send a single binary response frame, as the daemon does for file bodies. */
function sendBinary(socket: Socket, id: string, bytes: Uint8Array): void {
  writeMessage(
    socket,
    { id, headers: { "content-length": String(bytes.byteLength) } },
    bytes,
  );
}

/** Send a chunked binary response, as the daemon does for streams. */
function sendChunked(socket: Socket, id: string, chunks: Uint8Array[]): void {
  writeMessage(socket, { id, headers: { "transfer-encoding": "chunked" } });
  for (const chunk of chunks) writeStreamChunk(socket, chunk);
  writeStreamEnd(socket);
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
    const reader = new IpcFrameReader((envelope, binary) => {
      lastRequestBinary = binary;
      handler(envelope.id, envelope.method!, envelope.params, socket);
    });
    socket.on("data", (chunk) => {
      reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  test("resolves with the result field from the response", async () => {
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

  test("opts.timeoutMs rejects promptly and tears down the socket when the server never responds", async () => {
    const sockPath = setupWorkspace();
    let serverSocket: Socket | undefined;

    await startServer(sockPath, (_id, _method, _params, socket) => {
      // Wedged daemon: accept the request, never respond.
      serverSocket = socket;
    });

    const start = Date.now();
    const promise = ipcCallAssistant("slow_method", undefined, {
      timeoutMs: 50,
    });
    await expect(promise).rejects.toBeInstanceOf(IpcTransportError);
    await expect(promise).rejects.toThrow("Call timed out after 50ms");
    expect(Date.now() - start).toBeLessThan(5_000);

    // The timed-out client socket is destroyed — the server observes the
    // close instead of holding a leaked connection.
    expect(serverSocket).toBeDefined();
    const closed = await new Promise<boolean>((resolve) => {
      if (serverSocket!.destroyed) return resolve(true);
      serverSocket!.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 2_000);
    });
    expect(closed).toBe(true);
  });

  test("opts.timeoutMs does not fire on a call that responds in time", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, { ok: true });
      socket.end();
    });

    const result = await ipcCallAssistant("fast_method", undefined, {
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ ok: true });
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

// ---------------------------------------------------------------------------
// Binary frames — the reason for the framed protocol
// ---------------------------------------------------------------------------

describe("binary bodies", () => {
  test("sends a request body as a binary frame, not re-encoded JSON", async () => {
    const sockPath = setupWorkspace();
    const body = new Uint8Array([0x00, 0xff, 0x7b, 0x0a, 0x80]);

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, "ok");
      socket.end();
    });

    await ipcCallAssistant("user_route_post", {}, { binary: body });

    // Byte-for-byte, including bytes that are not valid UTF-8 and a newline
    // that the legacy dialect would have treated as a message boundary.
    expect(lastRequestBinary).toEqual(body);
  });

  test("receives a single binary response body", async () => {
    const sockPath = setupWorkspace();
    const bytes = new Uint8Array([1, 2, 3, 250]);

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendBinary(socket, id, bytes);
      socket.end();
    });

    const res = await ipcCallAssistantRaw("m");

    expect(res.binary).toEqual(bytes);
  });

  test("accumulates a chunked response rather than hanging on it", async () => {
    // Legacy clients made the daemon buffer streams and then dropped the
    // bytes. Framed, the chunks actually arrive — and a client that ignored
    // them would wait out the full call timeout instead of resolving.
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendChunked(socket, id, [
        new Uint8Array([1, 2]),
        new Uint8Array([3]),
        new Uint8Array([4, 5]),
      ]);
      socket.end();
    });

    const res = await ipcCallAssistantRaw("m", undefined, { timeoutMs: 2000 });

    expect(res.binary).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  test("keeps returning the JSON result for ordinary calls", async () => {
    // The common path must be untouched by the transport change.
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendResult(socket, id, { ok: true });
      socket.end();
    });

    expect(await ipcCallAssistant("m")).toEqual({ ok: true });
  });

  test("surfaces a handler error even when the call carried a body", async () => {
    const sockPath = setupWorkspace();

    await startServer(sockPath, (id, _method, _params, socket) => {
      sendHandlerError(socket, id, "nope", 404, "NOT_FOUND");
      socket.end();
    });

    await expect(
      ipcCallAssistant("m", {}, { binary: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(IpcHandlerError);
  });
});
