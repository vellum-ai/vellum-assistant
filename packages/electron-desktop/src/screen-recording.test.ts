import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SCREEN_RECORDING_ABORT,
  SCREEN_RECORDING_APPEND,
  SCREEN_RECORDING_BEGIN,
  SCREEN_RECORDING_FINISH,
  SCREEN_RECORDING_RESOLVE_SOURCE,
} from "@vellumai/ipc-contract";
import type { IpcHandle } from "./ipc";

const displayHandler = mock(() => undefined);
const getSources = mock(async () => [
  { id: "screen:1:0", display_id: "display-1" },
  { id: "window:42:0", display_id: "" },
]);
mock.module("electron", () => ({
  desktopCapturer: { getSources },
  session: {
    defaultSession: { setDisplayMediaRequestHandler: displayHandler },
  },
}));

const { installScreenRecording, resolveScreenRecordingDirectory } =
  await import("./screen-recording");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  getSources.mockClear();
});

const installHarness = () => {
  const appDataDir = mkdtempSync(path.join(os.tmpdir(), "screen-recording-"));
  tempDirs.push(appDataDir);
  const handlers = new Map<
    string,
    (args: unknown[]) => unknown | Promise<unknown>
  >();
  const handle = ((channel, _schema, fn) => {
    handlers.set(channel, (args) => fn(args as never, {} as never));
  }) as IpcHandle;
  installScreenRecording({ appDataDir, handle });
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`Missing handler: ${channel}`);
    }
    return Promise.resolve(handler(args)) as Promise<T>;
  };
  return { appDataDir, invoke };
};

test("writes ordered chunks and returns a file in the shared recordings directory", async () => {
  const { appDataDir, invoke } = installHarness();
  const recordingId = "00000000-0000-4000-8000-000000000001";

  await invoke(SCREEN_RECORDING_BEGIN, recordingId);
  await Promise.all([
    invoke(
      SCREEN_RECORDING_APPEND,
      recordingId,
      new Uint8Array([1, 2]),
    ),
    invoke(
      SCREEN_RECORDING_APPEND,
      recordingId,
      new Uint8Array([3, 4]),
    ),
  ]);
  const result = await invoke<{ filePath: string }>(
    SCREEN_RECORDING_FINISH,
    recordingId,
  );

  expect(
    result.filePath.startsWith(resolveScreenRecordingDirectory(appDataDir)),
  ).toBeTrue();
  expect([...readFileSync(result.filePath)]).toEqual([1, 2, 3, 4]);
});

test("aborts partial files and releases the single-recording guard", async () => {
  const { appDataDir, invoke } = installHarness();
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";

  await invoke(SCREEN_RECORDING_BEGIN, firstId);
  await expect(
    invoke(SCREEN_RECORDING_BEGIN, secondId),
  ).rejects.toThrow("already active");
  const firstPath = path.join(
    resolveScreenRecordingDirectory(appDataDir),
    `screen-recording-${firstId}.webm`,
  );
  await invoke(SCREEN_RECORDING_ABORT, firstId);
  await invoke(SCREEN_RECORDING_BEGIN, secondId);
  const second = await invoke<{ filePath: string }>(
    SCREEN_RECORDING_FINISH,
    secondId,
  );

  expect(existsSync(firstPath)).toBeFalse();
  expect(existsSync(second.filePath)).toBeTrue();
});

test("resolves requested display and window sources", async () => {
  const { invoke } = installHarness();

  await expect(
    invoke(SCREEN_RECORDING_RESOLVE_SOURCE, {
      captureScope: "display",
      displayId: "display-1",
    }),
  ).resolves.toBe("screen:1:0");
  await expect(
    invoke(SCREEN_RECORDING_RESOLVE_SOURCE, {
      captureScope: "window",
      windowId: 42,
    }),
  ).resolves.toBe("window:42:0");
});
