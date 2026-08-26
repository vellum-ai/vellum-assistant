import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IpcHandle } from "./ipc";

type DisplayMediaHandler = (
  request: { audioRequested: boolean },
  callback: (streams: Record<string, unknown>) => void,
) => void | Promise<void>;

let installedDisplayHandler: DisplayMediaHandler | null = null;
let beforeQuit: (() => void) | null = null;
const displayHandler = mock((handler: DisplayMediaHandler) => {
  installedDisplayHandler = handler;
});
const showMessageBox = mock(async () => ({ response: 0 }));
const availableSources = [
  { id: "screen:1:0", display_id: "display-1", name: "Display 1" },
  { id: "window:42:0", display_id: "", name: "Example window" },
];
const getSources = mock(
  async ({ types }: { types: Array<"screen" | "window"> }) =>
    availableSources.filter((source) =>
      types.includes(source.id.startsWith("screen:") ? "screen" : "window"),
    ),
);
mock.module("@vellumai/ipc-contract", () => ({
  SCREEN_RECORDING_ABORT: "vellum:screenRecording:abort",
  SCREEN_RECORDING_APPEND: "vellum:screenRecording:append",
  SCREEN_RECORDING_BEGIN: "vellum:screenRecording:begin",
  SCREEN_RECORDING_FINISH: "vellum:screenRecording:finish",
  SCREEN_RECORDING_READ: "vellum:screenRecording:read",
  SCREEN_RECORDING_RELEASE: "vellum:screenRecording:release",
  SCREEN_RECORDING_RESOLVE_SOURCE: "vellum:screenRecording:resolveSource",
}));
mock.module("electron", () => ({
  app: {
    once: mock((_event: string, listener: () => void) => {
      beforeQuit = listener;
    }),
  },
  desktopCapturer: { getSources },
  dialog: { showMessageBox },
  session: {
    defaultSession: { setDisplayMediaRequestHandler: displayHandler },
  },
}));

const { installScreenRecording, resolveScreenRecordingDirectory } =
  await import("./screen-recording");

const tempDirs: string[] = [];
const waitForRemoval = async (filePath: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for removal: ${filePath}`);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  getSources.mockClear();
  showMessageBox.mockClear();
  installedDisplayHandler = null;
  beforeQuit = null;
});

const installHarness = () => {
  const appDataDir = mkdtempSync(path.join(os.tmpdir(), "screen-recording-"));
  tempDirs.push(appDataDir);
  const handlers = new Map<
    string,
    (args: unknown[], owner: EventEmitter) => unknown | Promise<unknown>
  >();
  const handle = ((channel, _schema, fn) => {
    handlers.set(channel, (args, owner) =>
      fn(args as never, { sender: owner } as never),
    );
  }) as IpcHandle;
  installScreenRecording({ appDataDir, handle });
  const owner = new EventEmitter();
  const invokeAs = <T>(
    sender: EventEmitter,
    channel: string,
    ...args: unknown[]
  ): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`Missing handler: ${channel}`);
    }
    return Promise.resolve(handler(args, sender)) as Promise<T>;
  };
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    invokeAs(owner, channel, ...args);
  return {
    appDataDir,
    beforeQuit: () => beforeQuit?.(),
    invoke,
    invokeAs,
    owner,
  };
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
  await expect(
    invoke("vellum:screenRecording:resolveSource", {
      captureScope: "display",
    }),
  ).resolves.toBeNull();
});

test("infers window capture from windowId when captureScope is omitted", async () => {
  const { invoke } = installHarness();

  await expect(
    invoke("vellum:screenRecording:resolveSource", { windowId: 42 }),
  ).resolves.toBe("window:42:0");
  expect(getSources).toHaveBeenLastCalledWith({
    types: ["window"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  });
});

test("reads completed recordings in owner-bound chunks", async () => {
  const { invoke, invokeAs } = installHarness();
  const recordingId = "00000000-0000-4000-8000-000000000001";

  await invoke("vellum:screenRecording:begin", recordingId);
  await invoke(
    "vellum:screenRecording:append",
    recordingId,
    new Uint8Array([1, 2, 3, 4, 5]),
  );
  await invoke("vellum:screenRecording:finish", recordingId);

  await expect(
    invoke<{ data: Uint8Array; eof: boolean }>(
      "vellum:screenRecording:read",
      recordingId,
      0,
      3,
    ),
  ).resolves.toEqual({ data: new Uint8Array([1, 2, 3]), eof: false });
  await expect(
    invoke<{ data: Uint8Array; eof: boolean }>(
      "vellum:screenRecording:read",
      recordingId,
      3,
      3,
    ),
  ).resolves.toEqual({ data: new Uint8Array([4, 5]), eof: true });
  await expect(
    invokeAs(
      new EventEmitter(),
      "vellum:screenRecording:read",
      recordingId,
      0,
      3,
    ),
  ).rejects.toThrow("belongs to another window");

  await invoke("vellum:screenRecording:release", recordingId);
  await expect(
    invoke("vellum:screenRecording:read", recordingId, 0, 3),
  ).rejects.toThrow("not found");
});

test("uses the source selected in the fallback chooser", async () => {
  installHarness();
  showMessageBox.mockResolvedValueOnce({ response: 1 });
  const callback = mock(() => undefined);

  await installedDisplayHandler?.({ audioRequested: false }, callback);

  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      video: expect.objectContaining({ id: "window:42:0" }),
    }),
  );
});

test("limits prompted display selection to displays", async () => {
  const { invoke } = installHarness();

  await expect(
    invoke("vellum:screenRecording:resolveSource", {
      captureScope: "display",
      promptForSource: true,
    }),
  ).resolves.toBe("screen:1:0");

  expect(getSources).toHaveBeenLastCalledWith({
    types: ["screen"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  });
});

test("limits prompted window selection to windows", async () => {
  const { invoke } = installHarness();

  await expect(
    invoke("vellum:screenRecording:resolveSource", {
      captureScope: "window",
      promptForSource: true,
    }),
  ).resolves.toBe("window:42:0");

  expect(getSources).toHaveBeenLastCalledWith({
    types: ["window"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  });
});

test("releases a partial recording when its renderer is destroyed", async () => {
  const { appDataDir, invoke, owner } = installHarness();
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const firstPath = path.join(
    resolveScreenRecordingDirectory(appDataDir),
    `screen-recording-${firstId}.webm`,
  );

  await invoke("vellum:screenRecording:begin", firstId);
  owner.emit("destroyed");
  await invoke("vellum:screenRecording:begin", secondId);
  await waitForRemoval(firstPath);

  expect(existsSync(firstPath)).toBeFalse();
  await invoke("vellum:screenRecording:abort", secondId);
});

test("cleans up an active recording before app shutdown", async () => {
  const { appDataDir, beforeQuit: quit, invoke } = installHarness();
  const recordingId = "00000000-0000-4000-8000-000000000001";
  const recordingPath = path.join(
    resolveScreenRecordingDirectory(appDataDir),
    `screen-recording-${recordingId}.webm`,
  );

  await invoke("vellum:screenRecording:begin", recordingId);
  quit();
  await waitForRemoval(recordingPath);

  expect(existsSync(recordingPath)).toBeFalse();
});

test("rejects writes from a different renderer", async () => {
  const { invoke, invokeAs } = installHarness();
  const recordingId = "00000000-0000-4000-8000-000000000001";

  await invoke("vellum:screenRecording:begin", recordingId);

  await expect(
    invokeAs(
      new EventEmitter(),
      "vellum:screenRecording:append",
      recordingId,
      new Uint8Array([1]),
    ),
  ).rejects.toThrow("belongs to another window");
  await invoke("vellum:screenRecording:abort", recordingId);
});
