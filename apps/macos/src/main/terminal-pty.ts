/**
 * Main-process PTY manager for local terminal sessions.
 *
 * Spawns pseudo-terminal shells on the user's machine via `node-pty`,
 * tracks sessions by ID, and forwards data/exit events to the renderer
 * via `webContents.send`. Runs in the Electron main process — the only
 * context with native module access and no sandbox restrictions.
 *
 * Teardown safety: every `webContents.send` is guarded against
 * destroyed windows to prevent "object has been destroyed" crashes
 * during app quit or window close.
 */

import { type BrowserWindow, app, ipcMain } from "electron";
import * as nodePty from "node-pty";

import log from "./logger";

interface PtySession {
  pty: nodePty.IPty;
  sessionId: string;
}

const sessions = new Map<string, PtySession>();

let nextId = 1;

function generateSessionId(): string {
  return `local-pty-${nextId++}-${Date.now()}`;
}

function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  win.webContents.send(channel, ...args);
}

function resolveShell(): string {
  return process.env.SHELL || "/bin/zsh";
}

/**
 * Register IPC handlers for local terminal sessions. Call once from
 * the app lifecycle setup in `main/index.ts`.
 */
export function installTerminalPtyIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    "vellum:terminal:spawn",
    (_event, options?: { cols?: number; rows?: number }) => {
      const win = getWindow();
      if (!win) {
        return { ok: false, error: "No window available" };
      }

      const sessionId = generateSessionId();
      const shell = resolveShell();
      const cols = options?.cols ?? 80;
      const rows = options?.rows ?? 24;

      try {
        const pty = nodePty.spawn(shell, [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: process.env.HOME || "/",
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          } as Record<string, string>,
        });

        const session: PtySession = { pty, sessionId };
        sessions.set(sessionId, session);

        pty.onData((data: string) => {
          safeSend(win, "vellum:terminal:data", sessionId, data);
        });

        pty.onExit(({ exitCode, signal }) => {
          sessions.delete(sessionId);
          safeSend(win, "vellum:terminal:exit", sessionId, exitCode, signal);
        });

        log.info(`[terminal-pty] spawned session=${sessionId} shell=${shell}`);
        return { ok: true, sessionId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[terminal-pty] spawn failed: ${message}`);
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.on(
    "vellum:terminal:write",
    (_event, sessionId: string, data: string) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      session.pty.write(data);
    },
  );

  ipcMain.on(
    "vellum:terminal:resize",
    (_event, sessionId: string, cols: number, rows: number) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      try {
        session.pty.resize(cols, rows);
      } catch {
        // Resize can throw if the PTY has already exited
      }
    },
  );

  ipcMain.handle("vellum:terminal:kill", (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    try {
      session.pty.kill();
    } catch {
      // Kill can throw if already exited
    }
    sessions.delete(sessionId);
    log.info(`[terminal-pty] killed session=${sessionId}`);
  });

  app.on("before-quit", () => {
    for (const [id, session] of sessions) {
      try {
        session.pty.kill();
      } catch {
        // Best-effort cleanup
      }
      sessions.delete(id);
    }
  });
}
