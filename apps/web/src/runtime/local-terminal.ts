/**
 * Per-capability wrapper for the Electron host's local terminal bridge.
 *
 * Spawns a PTY shell on the user's machine via the main-process
 * `node-pty` manager. Off Electron (web, Capacitor iOS): all functions
 * are safe no-ops — spawn returns an error result, subscriptions return
 * unsubscribe-noops, and imperative methods are swallowed.
 */

import { isElectron } from "@/runtime/is-electron";

export type LocalTerminalSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

/** Spawn a local PTY shell session. Returns error off Electron. */
export async function spawnLocalTerminal(options?: {
  cols?: number;
  rows?: number;
}): Promise<LocalTerminalSpawnResult> {
  if (!isElectron()) {
    return { ok: false, error: "Local terminal is only available in the desktop app" };
  }
  return (
    (await window.vellum?.terminal?.spawn(options)) ?? {
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
