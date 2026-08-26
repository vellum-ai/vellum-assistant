import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, mock, test } from "bun:test";

import { RecordingTransferStore } from "../daemon/recording-transfer.js";

const testDirs: string[] = [];

afterEach(async () => {
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
  await store.append(recordingId, "client-1", new Uint8Array([1, 2]));
  await store.append(recordingId, "client-1", new Uint8Array([3, 4]));
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
    store.append(recordingId, "client-2", new Uint8Array([1])),
  ).rejects.toThrow("another client");
  await store.abort(recordingId, "client-1");
});
