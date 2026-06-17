/**
 * Per-capability wrapper for the Electron host's local terminal bridge.
 *
 * Opens an interactive shell in a self-hosted assistant's workspace via the
 * main-process `node-pty` manager (which runs `vellum exec -it`). Off Electron
 * (web, Capacitor iOS): all functions are safe no-ops — open returns an error
 * result, subscriptions return unsubscribe-noops, and imperative methods are
 * swallowed.
 */

import { isElectron } from "@/runtime/is-electron";

export type LocalTerminalSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

/** Open an interactive shell in the assistant's workspace. Returns error off Electron. */
export async function openLocalTerminal(options: {
  assistantId: string;
  service?: string;
  cols?: number;
  rows?: number;
}): Promise<LocalTerminalSpawnResult> {
  if (!isElectron()) {
    return {
      ok: false,
      error: "Local terminal is only available in the desktop app",
    };
  }
  return (
    (await window.vellum?.terminal?.open(options)) ?? {
      ok: false,
      error: "Terminal bridge unavailable",
    }
  );
}

/** Write input data to a local PTY session. No-op off Electron. */
export function writeLocalTerminal(sessionId: string, data: string): void {
  if (!isElectron()) {
    return;
  }
  window.vellum?.terminal?.write(sessionId, data);
}

/** Resize a local PTY session. No-op off Electron. */
export function resizeLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  if (!isElectron()) {
    return;
  }
  window.vellum?.terminal?.resize(sessionId, cols, rows);
}

/** Kill a local PTY session. No-op off Electron. */
export async function killLocalTerminal(sessionId: string): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.terminal?.kill(sessionId);
}

/** Subscribe to PTY output data. Returns an unsubscribe function. */
export function onLocalTerminalData(
  callback: (sessionId: string, data: string) => void,
): () => void {
  if (!isElectron()) {
    return () => undefined;
  }
  return window.vellum?.terminal?.onData(callback) ?? (() => undefined);
}

/** Subscribe to PTY exit events. Returns an unsubscribe function. */
export function onLocalTerminalExit(
  callback: (sessionId: string, exitCode: number, signal: number) => void,
): () => void {
  if (!isElectron()) {
    return () => undefined;
  }
  return window.vellum?.terminal?.onExit(callback) ?? (() => undefined);
}
