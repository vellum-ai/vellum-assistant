import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "handlers-blob-probe-test-"));
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

import { handleMessage, type HandlerContext } from "../daemon/handlers.js";
import type { IpcBlobProbe, ServerMessage } from "../daemon/ipc-protocol.js";
import { DebouncerMap } from "../util/debounce.js";

/** Write a probe file to the test blob directory. */
function writeProbeFile(probeId: string, content: Buffer): string {
  const filePath = join(blobDir, `${probeId}.blob`);
  writeFileSync(filePath, content);
  return filePath;
}

/** Create a minimal HandlerContext that captures sent messages. */
function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
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
  return { ctx, sent };
}

describe("handleIpcBlobProbe", () => {
  beforeEach(() => {
    if (existsSync(blobDir)) {
      rmSync(blobDir, { recursive: true });
    }
    mkdirSync(blobDir, { recursive: true });
  });

  test("success: probe file exists and hash matches", () => {
    const probeId = randomUUID();
    const nonce = randomBytes(32);
    const nonceSha256 = createHash("sha256").update(nonce).digest("hex");

    writeProbeFile(probeId, nonce);

    const msg: IpcBlobProbe = {
      type: "ipc_blob_probe",
      probeId,
      nonceSha256,
    };

    const { ctx, sent } = createTestContext();
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);

    expect(sent).toHaveLength(1);
    const result = sent[0] as {
      type: string;
      probeId: string;
      ok: boolean;
      observedNonceSha256?: string;
    };
    expect(result.type).toBe("ipc_blob_probe_result");
    expect(result.probeId).toBe(probeId);
    expect(result.ok).toBe(true);
    expect(result.observedNonceSha256).toBe(nonceSha256);

    // Probe file should be cleaned up
    expect(existsSync(join(blobDir, `${probeId}.blob`))).toBe(false);
  });

  test("failure: missing probe file", () => {
    const probeId = randomUUID();
    const nonceSha256 = createHash("sha256").update("anything").digest("hex");

    const msg: IpcBlobProbe = {
      type: "ipc_blob_probe",
      probeId,
      nonceSha256,
    };

    const { ctx, sent } = createTestContext();
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);

    expect(sent).toHaveLength(1);
    const result = sent[0] as {
      type: string;
      probeId: string;
      ok: boolean;
      reason?: string;
    };
    expect(result.type).toBe("ipc_blob_probe_result");
    expect(result.probeId).toBe(probeId);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_probe_file");
  });

  test("failure: hash mismatch", () => {
    const probeId = randomUUID();
    const nonce = randomBytes(32);
    const correctHash = createHash("sha256").update(nonce).digest("hex");
    // Compute a wrong hash by hashing different content
    const wrongHash = createHash("sha256")
      .update("wrong-nonce-data")
      .digest("hex");

    writeProbeFile(probeId, nonce);

    const msg: IpcBlobProbe = {
      type: "ipc_blob_probe",
      probeId,
      nonceSha256: wrongHash,
    };

    const { ctx, sent } = createTestContext();
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);

    expect(sent).toHaveLength(1);
    const result = sent[0] as {
      type: string;
      probeId: string;
      ok: boolean;
      reason?: string;
      observedNonceSha256?: string;
    };
    expect(result.type).toBe("ipc_blob_probe_result");
    expect(result.probeId).toBe(probeId);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
    expect(result.observedNonceSha256).toBe(correctHash);

    // Probe file should still be cleaned up even on mismatch
    expect(existsSync(join(blobDir, `${probeId}.blob`))).toBe(false);
  });

  test("failure: invalid probe id", () => {
    const msg: IpcBlobProbe = {
      type: "ipc_blob_probe",
      probeId: "../../../etc/passwd",
      nonceSha256: createHash("sha256").update("x").digest("hex"),
    };

    const { ctx, sent } = createTestContext();
    const fakeSocket = {} as net.Socket;

    handleMessage(msg, fakeSocket, ctx);

    expect(sent).toHaveLength(1);
    const result = sent[0] as {
      type: string;
      probeId: string;
      ok: boolean;
      reason?: string;
    };
    expect(result.type).toBe("ipc_blob_probe_result");
    expect(result.probeId).toBe("../../../etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_probe_id");
  });
});
