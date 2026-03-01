import type { ServerMessage } from '../../daemon/ipc-contract.js';
import { browserManager, SCREENCAST_HEIGHT, SCREENCAST_WIDTH } from './browser-manager.js';

// Track which sessions have an active browser page (no PiP surface — the user
// watches the actual browser window directly).
const activeBrowserSessions = new Set<string>();

// Registry of sendToClient callbacks per session
const sessionSenders = new Map<string, (msg: ServerMessage) => void>();

/**
 * Register a sendToClient callback for a session.
 * Called from session-tool-setup when the session is created.
 */
export function registerSessionSender(sessionId: string, sendToClient: (msg: ServerMessage) => void): void {
  sessionSenders.set(sessionId, sendToClient);
  browserManager.registerSender(sessionId, sendToClient as (msg: { type: string; sessionId: string }) => void);
}

/**
 * Unregister the sendToClient callback for a session.
 */
export function unregisterSessionSender(sessionId: string): void {
  sessionSenders.delete(sessionId);
  browserManager.unregisterSender(sessionId);
}

function getSender(sessionId: string): ((msg: ServerMessage) => void) | undefined {
  return sessionSenders.get(sessionId);
}

export async function ensureScreencast(
  sessionId: string,
  _sendToClient: (msg: ServerMessage) => void,
): Promise<void> {
  if (activeBrowserSessions.has(sessionId)) return;

  activeBrowserSessions.add(sessionId);

  try {
    // Ensure the page exists (may trigger browser launch/connect)
    await browserManager.getOrCreateSessionPage(sessionId);

    // No PiP surface or CDP screencast — the user watches the actual
    // browser window directly (positioned in top-right via positionWindowSidebar).
  } catch (err) {
    // Roll back so future calls can retry
    activeBrowserSessions.delete(sessionId);
    throw err;
  }
}

export function updateBrowserStatus(
  sessionId: string,
  _sendToClient: (msg: ServerMessage) => void,
  _status: 'navigating' | 'idle' | 'interacting',
  _actionText?: string,
  _currentUrl?: string,
): void {
  // No-op: PiP surface was removed so there is no ui_surface to update.
  // The function signature is preserved to avoid churn at callsites.
  if (!activeBrowserSessions.has(sessionId)) return;
}

export async function updatePagesList(
  sessionId: string,
  _sendToClient: (msg: ServerMessage) => void,
): Promise<void> {
  // No-op: PiP surface was removed so there is no ui_surface to update.
  if (!activeBrowserSessions.has(sessionId)) return;
}

export async function stopBrowserScreencast(
  sessionId: string,
  _sendToClient: (msg: ServerMessage) => void,
): Promise<void> {
  if (!activeBrowserSessions.has(sessionId)) return;

  // Safe no-op if CDP screencast was never started
  await browserManager.stopScreencast(sessionId);

  activeBrowserSessions.delete(sessionId);
}

export async function getElementBounds(
  sessionId: string,
  selector: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  try {
    const page = await browserManager.getOrCreateSessionPage(sessionId);
    const result = await page.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, vw: window.innerWidth, vh: window.innerHeight };
      })()
    `) as { x: number; y: number; w: number; h: number; vw: number; vh: number } | null;
    if (!result) return null;
    const scale = Math.min(SCREENCAST_WIDTH / result.vw, SCREENCAST_HEIGHT / result.vh);
    return {
      x: result.x * scale,
      y: result.y * scale,
      w: result.w * scale,
      h: result.h * scale,
    };
  } catch {
    return null;
  }
}

export function updateHighlights(
  sessionId: string,
  _sendToClient: (msg: ServerMessage) => void,
  _highlights: Array<{ x: number; y: number; w: number; h: number; label: string }>,
): void {
  // No-op: PiP surface was removed so there is no ui_surface to update.
  if (!activeBrowserSessions.has(sessionId)) return;
}

export async function stopAllScreencasts(): Promise<void> {
  for (const sessionId of activeBrowserSessions) {
    try {
      await browserManager.stopScreencast(sessionId);
    } catch { /* best-effort */ }
  }
  activeBrowserSessions.clear();
}

export function isScreencastActive(sessionId: string): boolean {
  return activeBrowserSessions.has(sessionId);
}

export { getSender };
