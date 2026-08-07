import { expect, mock, test } from "bun:test";
import path from "node:path";

import { FILE_OPEN_DRAIN, FILE_OPEN_EVENT } from "@vellumai/ipc-contract";

type Listener = (...args: unknown[]) => unknown;

const appListeners = new Map<string, Listener[]>();
const invokeListeners = new Map<string, Listener>();
const ipcListeners = new Map<string, Listener>();
const sent = mock(() => undefined);
const ensureVisible = mock(() => undefined);

mock.module("electron", () => ({
  app: {
    isReady: () => true,
    on: (event: string, listener: Listener) => {
      appListeners.set(event, [...(appListeners.get(event) ?? []), listener]);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: sent },
      },
    ],
  },
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      invokeListeners.set(channel, listener);
    },
    on: (channel: string, listener: Listener) => {
      ipcListeners.set(channel, listener);
    },
  },
}));
mock.module("./main-window", () => ({ ensureVisible }));

const { default: fileOpenModule } = await import("./features/file-open");
const { resolveAllowedOrigin } = await import("./app-origin.client");

const makeEvent = () => {
  let destroyed: (() => void) | undefined;
  const allowed = resolveAllowedOrigin();
  return {
    event: {
      senderFrame: { origin: `${allowed.protocol}//${allowed.host}` },
      sender: {
        once: (event: string, listener: () => void) => {
          if (event === "destroyed") {
            destroyed = listener;
          }
        },
      },
    },
    destroy: () => destroyed?.(),
  };
};

test("delivers canonical first-instance and second-instance file paths once", () => {
  const originalArgv = process.argv;
  const firstPath = "exports/例.vellum";
  process.argv = ["Vellum.exe", firstPath, firstPath, "notes.txt"];
  try {
    fileOpenModule.install({} as never);
  } finally {
    process.argv = originalArgv;
  }

  const firstEvent = makeEvent();
  expect(invokeListeners.get(FILE_OPEN_DRAIN)?.(firstEvent.event)).toEqual([
    path.resolve(firstPath),
  ]);
  firstEvent.destroy();

  const secondWorkingDirectory = path.resolve("secondary-launch");
  const secondRelativePath = "exports/second.vellum";
  const secondPath = path.resolve(secondWorkingDirectory, secondRelativePath);
  for (const listener of appListeners.get("second-instance") ?? []) {
    listener(
      {},
      ["Vellum.exe", secondRelativePath, secondRelativePath, "archive.vellum.bak"],
      secondWorkingDirectory,
    );
  }

  expect(invokeListeners.get(FILE_OPEN_DRAIN)?.(makeEvent().event)).toEqual([
    secondPath,
  ]);
  expect(sent).toHaveBeenCalledWith(FILE_OPEN_EVENT, secondPath);
  expect(ensureVisible).toHaveBeenCalledTimes(2);
});
