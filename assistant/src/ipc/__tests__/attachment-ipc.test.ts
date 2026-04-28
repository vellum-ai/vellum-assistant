/**
 * Integration tests for the attachment IPC routes.
 *
 * Exercises the full IPC round-trip: AssistantIpcServer + cliIpcCall over
 * the Unix domain socket, with the real SQLite attachment store backing
 * the route handlers.
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../../memory/db-init.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { AssistantIpcServer } from "../assistant-server.js";
import { cliIpcCall } from "../cli-client.js";

// ---------------------------------------------------------------------------
// DB setup (attachment store needs SQLite)
// ---------------------------------------------------------------------------

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let server: AssistantIpcServer | null = null;
const tempFiles: string[] = [];

/** Create a temp file inside the workspace directory. */
function createWorkspaceFile(content: string, filename?: string): string {
  const dir = join(getWorkspaceDir(), "data", "test-attachments");
  mkdirSync(dir, { recursive: true });
  const name = filename ?? `test-attachment-${Date.now()}.txt`;
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  tempFiles.push(filePath);
  return filePath;
}

/** Create a temp file outside the workspace directory (in system tmpdir). */
function createOutsideFile(content: string, filename?: string): string {
  const name = filename ?? `outside-attachment-${Date.now()}.txt`;
  const filePath = join(tmpdir(), name);
  writeFileSync(filePath, content);
  tempFiles.push(filePath);
  return filePath;
}

beforeEach(async () => {
  server = new AssistantIpcServer();
  await server.start();
  // Allow the server socket to bind.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(() => {
  server?.stop();
  server = null;

  // Clean up temp files.
  for (const filePath of tempFiles) {
    try {
      unlinkSync(filePath);
    } catch {
      /* file may already be gone */
    }
  }
  tempFiles.length = 0;
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredAttachmentResult {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachment IPC routes", () => {
  // -- attachment_register success ----------------------------------------

  test("attachment_register returns stored attachment for valid file", async () => {
    const filePath = createWorkspaceFile("hello world");

    const result = await cliIpcCall<StoredAttachmentResult>(
      "attachment_register",
      {
        body: {
          path: filePath,
          mimeType: "text/plain",
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
    expect(typeof result.result!.id).toBe("string");
    expect(result.result!.id.length).toBeGreaterThan(0);
    expect(result.result!.originalFilename).toContain("test-attachment-");
    expect(result.result!.mimeType).toBe("text/plain");
    expect(result.result!.sizeBytes).toBe(11); // "hello world".length
    expect(result.result!.kind).toBe("document");
    expect(typeof result.result!.createdAt).toBe("number");
  });

  test("attachment_register uses custom filename when provided", async () => {
    const filePath = createWorkspaceFile("custom name test");

    const result = await cliIpcCall<StoredAttachmentResult>(
      "attachment_register",
      {
        body: {
          path: filePath,
          mimeType: "image/png",
          filename: "screenshot.png",
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.result!.originalFilename).toBe("screenshot.png");
    expect(result.result!.mimeType).toBe("image/png");
    expect(result.result!.kind).toBe("image");
  });

  // -- attachment_register workspace restriction --------------------------

  test("attachment_register rejects paths outside workspace", async () => {
    const filePath = createOutsideFile("sensitive data");

    const result = await cliIpcCall("attachment_register", {
      body: {
        path: filePath,
        mimeType: "text/plain",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("must be within the workspace directory");
  });

  test("attachment_register rejects absolute paths outside workspace", async () => {
    const result = await cliIpcCall("attachment_register", {
      body: {
        path: "/etc/passwd",
        mimeType: "text/plain",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("must be within the workspace directory");
  });

  test("attachment_register rejects traversal attempts", async () => {
    const workspaceDir = getWorkspaceDir();
    const traversalPath = join(workspaceDir, "..", "..", "etc", "passwd");

    const result = await cliIpcCall("attachment_register", {
      body: {
        path: traversalPath,
        mimeType: "text/plain",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("must be within the workspace directory");
  });

  // -- attachment_register errors -----------------------------------------

  test("attachment_register errors when file does not exist", async () => {
    const workspaceDir = getWorkspaceDir();

    const result = await cliIpcCall("attachment_register", {
      body: {
        path: join(
          workspaceDir,
          "nonexistent-file-that-should-not-exist-12345.txt",
        ),
        mimeType: "text/plain",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("File not found");
  });

  test("attachment_register rejects missing path", async () => {
    const result = await cliIpcCall("attachment_register", {
      body: {
        mimeType: "text/plain",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("attachment_register rejects missing mimeType", async () => {
    const filePath = createWorkspaceFile("missing mime type");

    const result = await cliIpcCall("attachment_register", {
      body: {
        path: filePath,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  // -- attachment_lookup workspace restriction ----------------------------

  test("attachment_lookup rejects paths outside workspace", async () => {
    const result = await cliIpcCall("attachment_lookup", {
      body: {
        sourcePath: "/etc/passwd",
        conversationId: "some-conversation-id",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("must be within the workspace directory");
  });

  // -- attachment_lookup errors -------------------------------------------

  test("attachment_lookup errors when no attachment matches", async () => {
    const workspaceDir = getWorkspaceDir();

    const result = await cliIpcCall("attachment_lookup", {
      body: {
        sourcePath: join(workspaceDir, "nonexistent", "path", "file.txt"),
        conversationId: "nonexistent-conversation-id",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No attachment found");
  });

  test("attachment_lookup rejects missing sourcePath", async () => {
    const result = await cliIpcCall("attachment_lookup", {
      body: {
        conversationId: "some-conversation-id",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("attachment_lookup rejects missing conversationId", async () => {
    const result = await cliIpcCall("attachment_lookup", {
      body: {
        sourcePath: "/some/path",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
