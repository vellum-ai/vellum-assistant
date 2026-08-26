import { rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, jest, mock, test } from "bun:test";

import {
  RecordingTransferStore,
  TRANSFER_IDLE_TIMEOUT_MS,
} from "../daemon/recording-transfer.js";

const testDirs: string[] = [];

afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(
    testDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("streams ordered chunks into a file-backed recording attachment", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const registerAttachment = mock(
    (
      _filename: string,
      _mimeType: string,
      _filePath: string,
      _sizeBytes: number,
    ) => ({ id: "attachment-1" }),
  );
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment,
  });
  const recordingId = "00000000-0000-4000-8000-000000000001";

  await store.begin(recordingId, "client-1");
  await store.begin(recordingId, "client-1");
  await store.append(recordingId, "client-1", 0, new Uint8Array([1, 2]));
  await store.append(recordingId, "client-1", 0, new Uint8Array([1, 2]));
  await store.append(recordingId, "client-1", 1, new Uint8Array([3, 4]));
  const attachmentId = await store.finish(recordingId, "client-1");

  expect(attachmentId).toBe("attachment-1");
  expect(registerAttachment).toHaveBeenCalledTimes(1);
  const [, , filePath, sizeBytes] = registerAttachment.mock.calls[0]!;
  expect(sizeBytes).toBe(4);
  expect([...(await readFile(filePath))]).toEqual([1, 2, 3, 4]);
});

test("rejects transfer writes from a client that did not begin it", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment: () => ({ id: "attachment-1" }),
  });
  const recordingId = "00000000-0000-4000-8000-000000000001";

  await store.begin(recordingId, "client-1");

  await expect(
    store.append(recordingId, "client-2", 0, new Uint8Array([1])),
  ).rejects.toThrow("another client");
  await store.abort(recordingId, "client-1");
});

test("replaces an abandoned transfer when ownership changes", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const registerAttachment = mock(
    (
      _filename: string,
      _mimeType: string,
      _filePath: string,
      _sizeBytes: number,
    ) => ({ id: "attachment-2" }),
  );
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment,
  });
  const recordingId = "00000000-0000-4000-8000-000000000001";

  await store.begin(recordingId, "client-1");
  await store.append(recordingId, "client-1", 0, new Uint8Array([1, 2]));
  await store.begin(recordingId, "client-2");
  await expect(
    store.append(recordingId, "client-1", 1, new Uint8Array([3])),
  ).rejects.toThrow("another client");
  await store.append(recordingId, "client-2", 0, new Uint8Array([4, 5]));
  await store.finish(recordingId, "client-2");

  const [, , filePath] = registerAttachment.mock.calls[0]!;
  expect([...(await readFile(filePath))]).toEqual([4, 5]);
});

test("returns the same attachment when finish is retried", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const registerAttachment = mock(
    (
      _filename: string,
      _mimeType: string,
      _filePath: string,
      _sizeBytes: number,
    ) => ({ id: "attachment-1" }),
  );
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment,
  });
  const recordingId = "00000000-0000-4000-8000-000000000001";

  await store.begin(recordingId, "client-1");
  await store.append(recordingId, "client-1", 0, new Uint8Array([1]));

  expect(await store.finish(recordingId, "client-1")).toBe("attachment-1");
  expect(await store.finish(recordingId, "client-1")).toBe("attachment-1");
  expect(registerAttachment).toHaveBeenCalledTimes(1);
});

test("aborts a transfer that exceeds the cumulative size limit", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment: () => ({ id: "attachment-limit" }),
    maxBytes: 3,
  });
  const recordingId = "00000000-0000-4000-8000-000000000004";

  await store.begin(recordingId, "client-1");
  await store.append(recordingId, "client-1", 0, new Uint8Array([1, 2]));
  await expect(
    store.append(recordingId, "client-1", 1, new Uint8Array([3, 4])),
  ).rejects.toThrow("size limit");

  expect(await readdir(rootDir)).toEqual([]);
  await expect(store.finish(recordingId, "client-1")).rejects.toThrow(
    "not found",
  );
});

test("deletes a completed transfer when its owner aborts", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  let completedPath = "";
  const deleteAttachment = mock((_attachmentId: string) => {
    rmSync(completedPath, { force: true });
  });
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment: (_filename, _mimeType, filePath) => {
      completedPath = filePath;
      return { id: "attachment-failed-finalization" };
    },
    deleteAttachment,
  });
  const recordingId = "00000000-0000-4000-8000-000000000005";

  await store.begin(recordingId, "client-1");
  await store.append(recordingId, "client-1", 0, new Uint8Array([1, 2]));
  await store.finish(recordingId, "client-1");
  await expect(readFile(completedPath)).resolves.toEqual(Buffer.from([1, 2]));

  await store.abort(recordingId, "client-1");

  expect(deleteAttachment).toHaveBeenCalledWith(
    "attachment-failed-finalization",
  );
  await expect(readFile(completedPath)).rejects.toThrow();
});

test("cleans an unlinked completed transfer after its timeout", async () => {
  jest.useFakeTimers();
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const deleteAttachment = mock((_attachmentId: string) => undefined);
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment: () => ({ id: "attachment-timeout" }),
    deleteAttachment,
  });
  const recordingId = "00000000-0000-4000-8000-000000000006";

  await store.begin(recordingId, "client-1");
  await store.append(recordingId, "client-1", 0, new Uint8Array([1]));
  await store.finish(recordingId, "client-1");
  jest.advanceTimersByTime(TRANSFER_IDLE_TIMEOUT_MS);

  expect(deleteAttachment).toHaveBeenCalledWith("attachment-timeout");
});

test("claim keepalive preserves a paused transfer beyond the idle timeout", async () => {
  jest.useFakeTimers();
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment: () => ({ id: "attachment-paused" }),
  });
  const recordingId = "00000000-0000-4000-8000-000000000002";

  await store.begin(recordingId, "client-1");
  await store.append(recordingId, "client-1", 0, new Uint8Array([1]));
  for (let elapsed = 0; elapsed < 90; elapsed += 30) {
    jest.advanceTimersByTime(30 * 60 * 1000);
    expect(store.keepAlive(recordingId, "client-1")).toBeTrue();
  }

  jest.useRealTimers();
  expect(await store.finish(recordingId, "client-1")).toBe("attachment-paused");
});

test("a stale owner cannot renew another client's transfer", async () => {
  jest.useFakeTimers();
  const rootDir = await mkdtemp(path.join(tmpdir(), "recording-transfer-"));
  testDirs.push(rootDir);
  const store = new RecordingTransferStore({
    rootDir,
    registerAttachment: () => ({ id: "attachment-stale" }),
  });
  const recordingId = "00000000-0000-4000-8000-000000000003";

  await store.begin(recordingId, "client-1");
  jest.advanceTimersByTime(TRANSFER_IDLE_TIMEOUT_MS - 1);
  expect(store.keepAlive(recordingId, "client-2")).toBeFalse();
  jest.advanceTimersByTime(1);
  jest.useRealTimers();
  await Promise.resolve();

  await expect(store.finish(recordingId, "client-1")).rejects.toThrow(
    "not found",
  );
});
