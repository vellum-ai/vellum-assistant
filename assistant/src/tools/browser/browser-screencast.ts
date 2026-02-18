import { v4 as uuid } from 'uuid';
import { browserManager } from './browser-manager.js';
import type { BrowserViewSurfaceData, BrowserFrame, ServerMessage } from '../../daemon/ipc-contract.js';

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
    // Get current page info
    const page = await browserManager.getOrCreateSessionPage(sessionId);
    const currentUrl = page.url();
    const title = await page.title();

    // Send surface show
    sendToClient({
      type: 'ui_surface_show',
      sessionId,
      surfaceId,
      surfaceType: 'browser_view',
      title: 'Browser',
      data: {
        sessionId,
        currentUrl: currentUrl || 'about:blank',
        status: 'idle',
        pages: [{ id: sessionId, title: title || 'New Tab', url: currentUrl || 'about:blank', active: true }],
      } satisfies BrowserViewSurfaceData,
      display: 'panel',
    });

    // Start CDP screencast
    await browserManager.startScreencast(sessionId, (frame) => {
      sendToClient({
        type: 'browser_frame',
        sessionId,
        surfaceId,
        frame: frame.data,
        metadata: frame.metadata,
      } satisfies BrowserFrame);
    });
  } catch (err) {
    // Dismiss the surface we already showed so the client doesn't have an orphaned panel
    sendToClient({
      type: 'ui_surface_dismiss',
      sessionId,
      surfaceId,
    });
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
  sendToClient: (msg: ServerMessage) => void,
): Promise<void> {
  const state = activeScreencasts.get(sessionId);
  if (!state) return;

  await browserManager.stopScreencast(sessionId);

  sendToClient({
    type: 'ui_surface_dismiss',
    sessionId,
    surfaceId: state.surfaceId,
  });

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
    const scale = Math.min(800 / result.vw, 600 / result.vh);
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
  for (const [sessionId, state] of entries) {
    try {
      await browserManager.stopScreencast(sessionId);
    } catch { /* best-effort */ }
    const sender = sessionSenders.get(sessionId);
    if (sender) {
      sender({
        type: 'ui_surface_dismiss',
        sessionId,
        surfaceId: state.surfaceId,
      });
    }
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
