import { v4 as uuid } from 'uuid';

import type { ServerMessage } from '../../daemon/ipc-contract.js';
import { browserManager, SCREENCAST_HEIGHT, SCREENCAST_WIDTH } from './browser-manager.js';

// Track active screencast sessions
const activeScreencasts = new Map<string, { surfaceId: string }>();

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
  sendToClient: (msg: ServerMessage) => void,
): Promise<void> {
  if (activeScreencasts.has(sessionId)) return;

  const surfaceId = uuid();
  activeScreencasts.set(sessionId, { surfaceId });

  try {
    // Ensure the page exists (may trigger browser launch/connect)
    await browserManager.getOrCreateSessionPage(sessionId);

    // Skip PiP surface and CDP screencast — the user watches the actual
    // browser window directly (positioned in top-right via positionWindowSidebar).
  } catch (err) {
    // Roll back so future calls can retry
    activeScreencasts.delete(sessionId);
    throw err;
  }
}

export function updateBrowserStatus(
  sessionId: string,
  sendToClient: (msg: ServerMessage) => void,
  status: 'navigating' | 'idle' | 'interacting',
  actionText?: string,
  currentUrl?: string,
): void {
  const state = activeScreencasts.get(sessionId);
  if (!state) return;

  const update: Record<string, unknown> = { status };
  if (actionText !== undefined) update.actionText = actionText;
  if (currentUrl !== undefined) update.currentUrl = currentUrl;

  sendToClient({
    type: 'ui_surface_update',
    sessionId,
    surfaceId: state.surfaceId,
    data: update,
  });
}

export async function updatePagesList(
  sessionId: string,
  sendToClient: (msg: ServerMessage) => void,
): Promise<void> {
  const state = activeScreencasts.get(sessionId);
  if (!state) return;

  const page = await browserManager.getOrCreateSessionPage(sessionId);
  const currentUrl = page.url();
  const title = await page.title();

  sendToClient({
    type: 'ui_surface_update',
    sessionId,
    surfaceId: state.surfaceId,
    data: {
      currentUrl,
      pages: [{ id: sessionId, title: title || 'Untitled', url: currentUrl, active: true }],
    },
  });
}

export async function stopBrowserScreencast(
  sessionId: string,
  _sendToClient: (msg: ServerMessage) => void,
): Promise<void> {
  const state = activeScreencasts.get(sessionId);
  if (!state) return;

  // Safe no-op if CDP screencast was never started
  await browserManager.stopScreencast(sessionId);

  // Skip ui_surface_dismiss — no PiP surface was shown
  activeScreencasts.delete(sessionId);
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
  sendToClient: (msg: ServerMessage) => void,
  highlights: Array<{ x: number; y: number; w: number; h: number; label: string }>,
): void {
  const state = activeScreencasts.get(sessionId);
  if (!state) return;
  sendToClient({
    type: 'ui_surface_update',
    sessionId,
    surfaceId: state.surfaceId,
    data: { highlights },
  });
}

export async function stopAllScreencasts(): Promise<void> {
  const entries = Array.from(activeScreencasts.entries());
  for (const [sessionId] of entries) {
    try {
      await browserManager.stopScreencast(sessionId);
    } catch { /* best-effort */ }
    // Skip ui_surface_dismiss — no PiP surfaces were shown
  }
  activeScreencasts.clear();
}

export function isScreencastActive(sessionId: string): boolean {
  return activeScreencasts.has(sessionId);
}

export { getSender };

export function getScreencastSurfaceId(sessionId: string): string | null {
  const state = activeScreencasts.get(sessionId);
  return state?.surfaceId ?? null;
}
