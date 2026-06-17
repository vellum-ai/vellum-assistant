/**
 * Main-process PTY manager for the local assistant workspace terminal.
 *
 * Opens an interactive shell in a self-hosted assistant's workspace by running
 * the bundled `vellum exec -it <assistantId> -- bash` through `node-pty`. The
 * CLI resolves the runtime (local / docker / apple-container) and lands the
 * shell in the workspace; this process owns the PTY and bridges data/exit
 * events to the renderer via `webContents.send`.
 *
 * Platform-hosted (`cloud: "vellum"`) assistants are rejected — they use the
 * platform terminal API instead.
 *
 * Teardown safety: every `webContents.send` is guarded against destroyed
 * windows, and closing a session escalates SIGHUP → SIGKILL after a grace
 * period so a wedged shell can't outlive its window.
 */

import { type BrowserWindow, app, ipcMain } from "electron";
import * as nodePty from "node-pty";

import { buildInstallEnv } from "./cli-installer";
import { resolveCliInvocation } from "./local-mode";
import { getWatchedLockfile } from "./lockfile-watcher";
import log from "./logger";

interface PtySession {
  pty: nodePty.IPty;
  sessionId: string;
  killTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, PtySession>();

let nextId = 1;

// Grace period before a SIGHUP close escalates to SIGKILL.
const KILL_GRACE_MS = 2000;

// Shell to run inside the workspace. The assistant runtime always ships bash
// (the daemon's `bash` tool runs `bash -c`), so this is safe across local and
// containerized assistants.
const WORKSPACE_SHELL = "bash";

function generateSessionId(): string {
  return `local-pty-${nextId++}-${Date.now()}`;
}

function safeSend(
  win: BrowserWindow,
  channel: string,
  ...args: unknown[]
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  win.webContents.send(channel, ...args);
}

/**
 * Send SIGHUP and, if the shell hasn't exited within the grace period,
 * escalate to SIGKILL. The `onExit` handler clears the timer and removes the
 * session, so this is the single place a close is initiated.
 */
function killSession(session: PtySession): void {
  try {
    session.pty.kill();
  } catch {
    // Already exited.
  }
  if (session.killTimer) {
    return;
  }
  const timer = setTimeout(() => {
    try {
      session.pty.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, KILL_GRACE_MS);
  if (typeof timer.unref === "function") timer.unref();
  session.killTimer = timer;
}

/**
 * Register IPC handlers for local assistant workspace terminals. Call once from
 * the app lifecycle setup in `main/index.ts`.
 */
export function installTerminalPtyIpc(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle(
    "vellum:terminal:open",
    async (
      _event,
      options?: {
        assistantId?: string;
        service?: string;
        cols?: number;
        rows?: number;
      },
    ) => {
      const win = getWindow();
      if (!win) {
        return { ok: false, error: "No window available" };
      }

      const assistantId = options?.assistantId;
      if (!assistantId) {
        return { ok: false, error: "Missing assistantId" };
      }

      // Self-hosted assistants only; platform-hosted ones have their own
      // platform-routed terminal.
      const entry = getWatchedLockfile().assistants.find(
        (a) => a.assistantId === assistantId,
      );
      if (entry?.cloud === "vellum") {
        return {
          ok: false,
          error: "Platform-hosted assistants use the platform terminal.",
        };
      }

      const service = options?.service ?? "assistant";
      const cols = options?.cols ?? 80;
      const rows = options?.rows ?? 24;

      try {
        const { command, baseArgs } = await resolveCliInvocation();
        const args = [
          ...baseArgs,
          "exec",
          assistantId,
          "-it",
          "--service",
          service,
          "--",
          WORKSPACE_SHELL,
        ];

        const sessionId = generateSessionId();
        const pty = nodePty.spawn(command, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: process.env.HOME || "/",
          env: {
            ...buildInstallEnv(),
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
          const existing = sessions.get(sessionId);
          if (existing?.killTimer) {
            clearTimeout(existing.killTimer);
          }
          sessions.delete(sessionId);
          safeSend(win, "vellum:terminal:exit", sessionId, exitCode, signal);
        });

        log.info(
          `[terminal-pty] opened session=${sessionId} assistant=${assistantId} service=${service}`,
        );
        return { ok: true, sessionId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[terminal-pty] open failed: ${message}`);
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
        // Resize can throw if the PTY has already exited.
      }
    },
  );

  ipcMain.handle("vellum:terminal:kill", (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    // SIGHUP now, SIGKILL after the grace period; `onExit` removes the session.
    killSession(session);
    log.info(`[terminal-pty] closing session=${sessionId}`);
  });

  app.on("before-quit", () => {
    for (const [id, session] of sessions) {
      if (session.killTimer) {
        clearTimeout(session.killTimer);
      }
      try {
        session.pty.kill();
      } catch {
        // Best-effort cleanup.
      }
      sessions.delete(id);
    }
  });
}
