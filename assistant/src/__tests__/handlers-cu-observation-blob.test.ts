import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "handlers-cu-blob-test-"));
const blobDir = join(testDir, "ipc-blobs");

// Mock platform module so blob store writes to temp dir
mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => blobDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  getSandboxWorkingDir: () => join(testDir, "sandbox"),
  ensureDataDir: () => {},
}));

// Mock logger to suppress output during tests
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

import { ComputerUseSession } from "../daemon/computer-use-session.js";
import { handleMessage, type HandlerContext } from "../daemon/handlers.js";
import type {
  CuObservation,
  IpcBlobRef,
  ServerMessage,
} from "../daemon/ipc-protocol.js";
import { DebouncerMap } from "../util/debounce.js";

/** Poll until a predicate is true or timeout (default 2s). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Write a blob file to the test blob directory and return the IpcBlobRef. */
function writeBlobFile(
  content: Buffer,
  kind: IpcBlobRef["kind"],
  encoding: IpcBlobRef["encoding"],
): IpcBlobRef {
  const id = randomUUID();
  const filePath = join(blobDir, `${id}.blob`);
  writeFileSync(filePath, content);
  return {
    id,
    kind,
    encoding,
    byteLength: content.byteLength,
  };
}

/** Create a minimal HandlerContext with a mock CU session that captures observations. */
function createTestContext(sessionId: string): {
  ctx: HandlerContext;
  sent: ServerMessage[];
  observations: CuObservation[];
} {
  const sent: ServerMessage[] = [];
  const observations: CuObservation[] = [];

  // Create a mock CU session that captures the observation passed to handleObservation
  const mockCuSession = {
    handleObservation: async (obs: CuObservation) => {
      observations.push(obs);
    },
  } as unknown as ComputerUseSession;

  const cuSessions = new Map<string, ComputerUseSession>();
  cuSessions.set(sessionId, mockCuSession);

  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions,
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket, msg) => {
      sent.push(msg);
    },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => {
      throw new Error("not implemented");
    },
    touchSession: () => {},
  };
  return { ctx, sent, observations };
}

describe("handleCuObservation blob hydration", () => {
  beforeEach(() => {
    if (existsSync(blobDir)) {
      rmSync(blobDir, { recursive: true });
    }
    mkdirSync(blobDir, { recursive: true });
  });

  test("blob-only axTree: hydrates from blob as UTF-8", async () => {
    const sessionId = randomUUID();
    const axTreeContent = '<ax-tree>Button [1] "OK"</ax-tree>';
    const axTreeBuf = Buffer.from(axTreeContent, "utf8");
    const blobRef = writeBlobFile(axTreeBuf, "ax_tree", "utf8");

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      axTreeBlob: blobRef,
    };

    const { ctx, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);

    // handleCuObservation is async (fire-and-forget); poll until it completes
    await waitFor(() => observations.length > 0);

    expect(observations).toHaveLength(1);
    expect(observations[0].axTree).toBe(axTreeContent);

    // Blob file should be cleaned up after hydration
    expect(existsSync(join(blobDir, `${blobRef.id}.blob`))).toBe(false);
  });

  test("blob-only screenshot: hydrates as base64", async () => {
    const sessionId = randomUUID();
    // Simulate JPEG bytes (just random data for testing)
    const jpegBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    ]);
    const blobRef = writeBlobFile(jpegBytes, "screenshot_jpeg", "binary");

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      screenshotBlob: blobRef,
    };

    const { ctx, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    expect(observations).toHaveLength(1);
    // Screenshot should be base64-encoded for the provider path
    expect(observations[0].screenshot).toBe(jpegBytes.toString("base64"));

    // Blob file should be cleaned up
    expect(existsSync(join(blobDir, `${blobRef.id}.blob`))).toBe(false);
  });

  test("blob-first: blob succeeds, inline value is overwritten", async () => {
    const sessionId = randomUUID();
    const blobAxTree = "Blob AX tree content";
    const inlineAxTree = "Inline AX tree content";
    const blobRef = writeBlobFile(
      Buffer.from(blobAxTree, "utf8"),
      "ax_tree",
      "utf8",
    );

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      axTree: inlineAxTree,
      axTreeBlob: blobRef,
    };

    const { ctx, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    expect(observations).toHaveLength(1);
    // Blob takes precedence when both are present and blob succeeds
    expect(observations[0].axTree).toBe(blobAxTree);
  });

  test("blob fails with inline fallback: uses inline value", async () => {
    const sessionId = randomUUID();
    const inlineAxTree = "Inline AX tree";
    // Create a blob ref that points to a non-existent file
    const blobRef: IpcBlobRef = {
      id: randomUUID(),
      kind: "ax_tree",
      encoding: "utf8",
      byteLength: 100,
    };

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      axTree: inlineAxTree,
      axTreeBlob: blobRef,
    };

    const { ctx, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    expect(observations).toHaveLength(1);
    // Inline value should be preserved as fallback when blob fails
    expect(observations[0].axTree).toBe(inlineAxTree);
  });

  test("blob failure with no inline fallback: continues with partial observation", async () => {
    const sessionId = randomUUID();
    // Create a blob ref that points to a non-existent file
    const blobRef: IpcBlobRef = {
      id: randomUUID(),
      kind: "ax_tree",
      encoding: "utf8",
      byteLength: 100,
    };

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      axTreeBlob: blobRef,
    };

    const { ctx, sent, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    // Should still forward to session with partial data (no axTree)
    expect(observations).toHaveLength(1);
    expect(observations[0].axTree).toBeUndefined();
    // Should NOT send cu_error
    expect(sent).toHaveLength(0);
  });

  test("wrong blob kind: fails validation and falls back to inline", async () => {
    const sessionId = randomUUID();
    const inlineScreenshot = "base64screenshotdata";
    // Create a blob with wrong kind for screenshotBlob field
    const blobRef = writeBlobFile(Buffer.from([0xff, 0xd8]), "ax_tree", "utf8");

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      screenshot: inlineScreenshot,
      screenshotBlob: blobRef,
    };

    const { ctx, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    expect(observations).toHaveLength(1);
    // Should fall back to inline because kind validation failed
    expect(observations[0].screenshot).toBe(inlineScreenshot);

    // Blob file should still be cleaned up despite validation failure
    expect(existsSync(join(blobDir, `${blobRef.id}.blob`))).toBe(false);
  });

  test("wrong blob kind with no inline fallback: continues with partial observation", async () => {
    const sessionId = randomUUID();
    // Create a blob with wrong kind for screenshotBlob field, no inline fallback
    const blobRef = writeBlobFile(Buffer.from([0xff, 0xd8]), "ax_tree", "utf8");

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      screenshotBlob: blobRef,
    };

    const { ctx, sent, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    // Should still forward to session with partial data (no screenshot)
    expect(observations).toHaveLength(1);
    expect(observations[0].screenshot).toBeUndefined();
    // Should NOT send cu_error
    expect(sent).toHaveLength(0);

    // Blob file should still be cleaned up despite validation failure
    expect(existsSync(join(blobDir, `${blobRef.id}.blob`))).toBe(false);
  });

  test("inline-only unchanged: no blob refs, observation passes through", async () => {
    const sessionId = randomUUID();
    const inlineAxTree = "Full AX tree text";
    const inlineScreenshot = "base64screenshotdata";

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      axTree: inlineAxTree,
      screenshot: inlineScreenshot,
    };

    const { ctx, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    expect(observations).toHaveLength(1);
    expect(observations[0].axTree).toBe(inlineAxTree);
    expect(observations[0].screenshot).toBe(inlineScreenshot);
  });

  test("both axTree and screenshot blobs hydrate independently", async () => {
    const sessionId = randomUUID();
    const axTreeContent = 'Window [1] "Editor"';
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);

    const axBlobRef = writeBlobFile(
      Buffer.from(axTreeContent, "utf8"),
      "ax_tree",
      "utf8",
    );
    const screenshotBlobRef = writeBlobFile(
      jpegBytes,
      "screenshot_jpeg",
      "binary",
    );

    const msg: CuObservation = {
      type: "cu_observation",
      sessionId,
      axTreeBlob: axBlobRef,
      screenshotBlob: screenshotBlobRef,
    };

    const { ctx, observations } = createTestContext(sessionId);
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);
    await waitFor(() => observations.length > 0);

    expect(observations).toHaveLength(1);
    expect(observations[0].axTree).toBe(axTreeContent);
    expect(observations[0].screenshot).toBe(jpegBytes.toString("base64"));

    // Both blob files should be cleaned up
    expect(existsSync(join(blobDir, `${axBlobRef.id}.blob`))).toBe(false);
    expect(existsSync(join(blobDir, `${screenshotBlobRef.id}.blob`))).toBe(
      false,
    );
  });
});
