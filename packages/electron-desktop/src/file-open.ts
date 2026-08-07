import { BrowserWindow, app, type WebContents } from "electron";
import path from "node:path";
import { z } from "zod";

import {
  FILE_OPEN_DRAIN,
  FILE_OPEN_EVENT,
  FILE_OPEN_SUBSCRIBE,
  FILE_OPEN_UNSUBSCRIBE,
} from "@vellumai/ipc-contract";

import type { createIpcRegistrar } from "./ipc";

/**
 * Inbound file-open events for `.vellum` bundles.
 *
 * The OS delivers paths through `open-file` or process argv. This module
 * captures, validates, and routes them through the same buffer, broadcast,
 * and subscriber pattern used by `deep-links.ts`.
 *
 * Lifecycle hooks (all required):
 *
 *   - `app.on("will-finish-launching", () => app.on("open-file", ...))`
 *     captures file paths delivered AT launch. Registering in
 *     `whenReady` misses the launching file — same pitfall as deep links.
 * Buffering: file paths arriving before the renderer subscribes are
 * queued in `pending[]`. The renderer drains via
 * `window.vellum.fileOpen.drain()` once mounted. Live file-open events
 * arriving after drain are broadcast to subscribers; unsubscribed
 * windows still receive broadcasts (same model as deep links).
 */

const VELLUM_EXT_RE = /\.vellum$/i;

type IpcRegistrar = ReturnType<typeof createIpcRegistrar>;

export interface FileOpenDependencies {
  ensureMainWindowVisible: () => void | Promise<void>;
  handle: IpcRegistrar["handle"];
  on: IpcRegistrar["on"];
}

let dependencies: FileOpenDependencies | null = null;

export const configureFileOpen = (next: FileOpenDependencies): void => {
  dependencies = next;
};

const getDependencies = (): FileOpenDependencies => {
  if (!dependencies) {
    throw new Error("File open module is not configured");
  }
  return dependencies;
};

export const canonicalizeVellumFilePath = (
  filePath: string,
  workingDirectory = process.cwd(),
): string | null => {
  if (!VELLUM_EXT_RE.test(filePath)) {
    return null;
  }
  return path.resolve(workingDirectory, filePath);
};

export const extractVellumFilePathsFromArgv = (
  argv: readonly string[],
  workingDirectory = process.cwd(),
): string[] => {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const arg of argv) {
    const filePath = canonicalizeVellumFilePath(arg, workingDirectory);
    if (!filePath) {
      continue;
    }
    const key =
      process.platform === "win32" ? filePath.toLowerCase() : filePath;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    paths.push(filePath);
  }
  return paths;
};

const pending: string[] = [];

const subscribers = new Set<WebContents>();

const fileOpenCallbacks = new Set<(path: string) => void>();

const broadcast = (filePath: string): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send(FILE_OPEN_EVENT, filePath);
  }
};

const notifyCallbacks = (filePath: string): void => {
  for (const cb of fileOpenCallbacks) {
    cb(filePath);
  }
};

export const handleFileOpen = (filePath: string): void => {
  const canonicalPath = canonicalizeVellumFilePath(filePath);
  if (!canonicalPath) {
    return;
  }
  if (subscribers.size === 0) {
    pending.push(canonicalPath);
  }
  broadcast(canonicalPath);
  notifyCallbacks(canonicalPath);
  if (app.isReady()) {
    void getDependencies().ensureMainWindowVisible();
  }
};

export const handleFileOpenArgv = (
  argv: readonly string[],
  workingDirectory = process.cwd(),
): void => {
  for (const filePath of extractVellumFilePathsFromArgv(
    argv,
    workingDirectory,
  )) {
    handleFileOpen(filePath);
  }
};

/**
 * Register a main-process callback invoked for every `.vellum` file-open event.
 * Returns an unsubscribe function. Any paths already buffered in `pending[]`
 * (cold-launch files that arrived before this callback was registered) are
 * replayed immediately so cold-launch `.vellum` files reach handlers like
 * `handleBundleFile` even though they arrived before `whenReady`.
 */
export const onFileOpen = (callback: (path: string) => void): (() => void) => {
  fileOpenCallbacks.add(callback);
  for (const filePath of pending) {
    callback(filePath);
  }
  return () => {
    fileOpenCallbacks.delete(callback);
  };
};

let installed = false;

export const installFileOpen = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const { handle, on } = getDependencies();

  app.on("will-finish-launching", () => {
    app.on("open-file", (event, filePath) => {
      event.preventDefault();
      handleFileOpen(filePath);
    });
  });

  handle(FILE_OPEN_DRAIN, z.tuple([]), (_args, event): string[] => {
    if (!subscribers.has(event.sender)) {
      subscribers.add(event.sender);
      event.sender.once("destroyed", () => {
        subscribers.delete(event.sender);
      });
    }
    return pending.splice(0, pending.length);
  });

  on(FILE_OPEN_SUBSCRIBE, z.tuple([]), (_args, event) => {
    if (subscribers.has(event.sender)) {
      return;
    }
    subscribers.add(event.sender);
    event.sender.once("destroyed", () => {
      subscribers.delete(event.sender);
    });
  });

  on(FILE_OPEN_UNSUBSCRIBE, z.tuple([]), (_args, event) => {
    subscribers.delete(event.sender);
  });
};

/**
 * Whether any `.vellum` file paths have been buffered before the
 * renderer drained them. Used by the move-to-Applications guard to
 * skip the prompt when the launch was triggered by a file open.
 */
export const hasPendingFiles = (): boolean => pending.length > 0;

export const __resetForTesting = (): void => {
  installed = false;
  subscribers.clear();
  fileOpenCallbacks.clear();
  pending.length = 0;
};
