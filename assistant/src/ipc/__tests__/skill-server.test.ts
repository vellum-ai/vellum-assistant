/**
 * Smoke test for the skill IPC server. Starts the server on a temp socket
 * path, connects with a raw socket client, and verifies the server dispatches
 * newline-delimited JSON messages — specifically, that unknown methods return
 * a structured error response.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SkillIpcServer } from "../skill-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string | null = null;
let server: SkillIpcServer | null = null;
let savedSkillIpcSocketDir: string | undefined;

beforeEach(() => {
  savedSkillIpcSocketDir = process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "skill-ipc-test-"));
  process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = tempDir;
});

afterEach(() => {
  server?.stop();
  server = null;
  if (savedSkillIpcSocketDir === undefined) {
    delete process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR;
  } else {
    process.env.ASSISTANT_SKILL_IPC_SOCKET_DIR = savedSkillIpcSocketDir;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function startServer(): Promise<SkillIpcServer> {
  const srv = new SkillIpcServer();
  await srv.start();
  // Give the listener a tick to bind.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return srv;
}

function sendRequest(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (
      value: { id: string; result?: unknown; error?: string } | Error,
    ) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify(payload) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx).trim();
      try {
        finish(JSON.parse(line));
      } catch (err) {
        finish(err as Error);
      }
    });

    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!settled) finish(new Error("Connection closed before response"));
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillIpcServer", () => {
  test("accepts connections and returns error for unknown methods", async () => {
    if (!tempDir) throw new Error("tempDir not initialized");
    const socketPath = join(tempDir, "assistant-skill.sock");
    server = await startServer();

    const response = await sendRequest(socketPath, {
      id: "req-1",
      method: "host.does.not.exist",
    });

    expect(response.id).toBe("req-1");
    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(response.error).toContain("host.does.not.exist");
  });

  test("returns error for malformed JSON", async () => {
    if (!tempDir) throw new Error("tempDir not initialized");
    const socketPath = join(tempDir, "assistant-skill.sock");
    server = await startServer();

    const response = await new Promise<{ id: string; error?: string }>(
      (resolve, reject) => {
        const socket: Socket = connect(socketPath);
        let buffer = "";
        let settled = false;
        const finish = (
          value: { id: string; error?: string } | Error,
        ): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (value instanceof Error) reject(value);
          else resolve(value);
        };
        socket.on("connect", () => {
          socket.write("not-valid-json\n");
        });
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const idx = buffer.indexOf("\n");
          if (idx === -1) return;
          const line = buffer.slice(0, idx).trim();
          try {
            finish(JSON.parse(line));
          } catch (err) {
            finish(err as Error);
          }
        });
        socket.on("error", (err) => finish(err));
      },
    );

    expect(response.error).toBe("Invalid JSON");
  });

  test("returns error for missing id/method fields", async () => {
    if (!tempDir) throw new Error("tempDir not initialized");
    const socketPath = join(tempDir, "assistant-skill.sock");
    server = await startServer();

    const response = await sendRequest(socketPath, { id: "req-2" });

    expect(response.id).toBe("req-2");
    expect(response.error).toContain("Missing");
  });

  test("dispatches registered methods and returns result", async () => {
    if (!tempDir) throw new Error("tempDir not initialized");
    const socketPath = join(tempDir, "assistant-skill.sock");
    server = await startServer();
    server.registerMethod("test.echo", (params) => ({ echoed: params }));

    const response = await sendRequest(socketPath, {
      id: "req-3",
      method: "test.echo",
      params: { value: 42 },
    });

    expect(response.id).toBe("req-3");
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ echoed: { value: 42 } });
  });
});
