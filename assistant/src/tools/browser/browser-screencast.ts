import type { ServerMessage } from "../../daemon/ipc-protocol.js";
import { browserManager } from "./browser-manager.js";

// Track which sessions have an active browser page.
const activeBrowserSessions = new Set<string>();

// Registry of sendToClient callbacks per session
const sessionSenders = new Map<string, (msg: ServerMessage) => void>();

/**
 * Register a sendToClient callback for a session.
 * Called from session-tool-setup when the session is created.
 */
export function registerSessionSender(
  sessionId: string,
  sendToClient: (msg: ServerMessage) => void,
): void {
  sessionSenders.set(sessionId, sendToClient);
}

/**
 * Unregister the sendToClient callback for a session.
 */
export function unregisterSessionSender(sessionId: string): void {
  sessionSenders.delete(sessionId);
}

function getSender(
  sessionId: string,
): ((msg: ServerMessage) => void) | undefined {
  return sessionSenders.get(sessionId);
}

export async function ensureScreencast(sessionId: string): Promise<void> {
  if (activeBrowserSessions.has(sessionId)) return;

  activeBrowserSessions.add(sessionId);

  try {
    // Ensure the page exists (may trigger browser launch/connect)
    await browserManager.getOrCreateSessionPage(sessionId);
  } catch (err) {
    // Roll back so future calls can retry
    activeBrowserSessions.delete(sessionId);
    throw err;
  }
}

export async function stopBrowserScreencast(sessionId: string): Promise<void> {
  if (!activeBrowserSessions.has(sessionId)) return;

  // Safe no-op if CDP screencast was never started
  await browserManager.stopScreencast(sessionId);

  activeBrowserSessions.delete(sessionId);
}

export async function stopAllScreencasts(): Promise<void> {
  for (const sessionId of activeBrowserSessions) {
    try {
      await browserManager.stopScreencast(sessionId);
    } catch {
      /* best-effort */
    }
  }
  activeBrowserSessions.clear();
}

export function isScreencastActive(sessionId: string): boolean {
  return activeBrowserSessions.has(sessionId);
}

export { getSender };
