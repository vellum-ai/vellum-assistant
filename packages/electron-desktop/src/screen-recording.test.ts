import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IpcHandle } from "./ipc";

const displayHandler = mock(() => undefined);
const getSources = mock(async () => [
  { id: "screen:1:0", display_id: "display-1" },
  { id: "window:42:0", display_id: "" },
]);
mock.module("@vellumai/ipc-contract", () => ({
  SCREEN_RECORDING_ABORT: "vellum:screenRecording:abort",
  SCREEN_RECORDING_APPEND: "vellum:screenRecording:append",
  SCREEN_RECORDING_BEGIN: "vellum:screenRecording:begin",
  SCREEN_RECORDING_FINISH: "vellum:screenRecording:finish",
  SCREEN_RECORDING_RESOLVE_SOURCE: "vellum:screenRecording:resolveSource",
}));
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

  await invoke("vellum:screenRecording:begin", recordingId);
  await Promise.all([
    invoke(
      "vellum:screenRecording:append",
      recordingId,
      new Uint8Array([1, 2]),
    ),
    invoke(
      "vellum:screenRecording:append",
      recordingId,
      new Uint8Array([3, 4]),
    ),
  ]);
  const result = await invoke<{ filePath: string }>(
    "vellum:screenRecording:finish",
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

  await invoke("vellum:screenRecording:begin", firstId);
  await expect(
    invoke("vellum:screenRecording:begin", secondId),
  ).rejects.toThrow("already active");
  const firstPath = path.join(
    resolveScreenRecordingDirectory(appDataDir),
    `screen-recording-${firstId}.webm`,
  );
  await invoke("vellum:screenRecording:abort", firstId);
  await invoke("vellum:screenRecording:begin", secondId);
  const second = await invoke<{ filePath: string }>(
    "vellum:screenRecording:finish",
    secondId,
  );

  expect(existsSync(firstPath)).toBeFalse();
  expect(existsSync(second.filePath)).toBeTrue();
});

test("resolves requested display and window sources", async () => {
  const { invoke } = installHarness();

  await expect(
    invoke("vellum:screenRecording:resolveSource", {
      captureScope: "display",
      displayId: "display-1",
    }),
  ).resolves.toBe("screen:1:0");
  await expect(
    invoke("vellum:screenRecording:resolveSource", {
      captureScope: "window",
      windowId: 42,
    }),
  ).resolves.toBe("window:42:0");
});
