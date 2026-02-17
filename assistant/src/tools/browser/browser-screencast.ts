import { v4 as uuid } from 'uuid';
import { browserManager } from './browser-manager.js';
import type { BrowserViewSurfaceData, BrowserFrame } from '../../daemon/ipc-contract.js';

// Track active screencast sessions
const activeScreencasts = new Map<string, { surfaceId: string }>();

// Registry of sendToClient callbacks per session
const sessionSenders = new Map<string, (msg: any) => void>();

/**
 * Register a sendToClient callback for a session.
 * Called from session-tool-setup when the session is created.
 */
export function registerSessionSender(sessionId: string, sendToClient: (msg: any) => void): void {
  sessionSenders.set(sessionId, sendToClient);
}

/**
 * Unregister the sendToClient callback for a session.
 */
export function unregisterSessionSender(sessionId: string): void {
  sessionSenders.delete(sessionId);
}

function getSender(sessionId: string): ((msg: any) => void) | undefined {
  return sessionSenders.get(sessionId);
}

export async function ensureScreencast(
  sessionId: string,
  sendToClient: (msg: any) => void,
): Promise<void> {
  if (activeScreencasts.has(sessionId)) return;

  const surfaceId = uuid();
  activeScreencasts.set(sessionId, { surfaceId });

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
}

export function updateBrowserStatus(
  sessionId: string,
  sendToClient: (msg: any) => void,
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
  sendToClient: (msg: any) => void,
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
  sendToClient: (msg: any) => void,
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
    const bounds = await page.evaluate(`
      (() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      })()
    `) as { x: number; y: number; w: number; h: number } | null;
    return bounds;
  } catch {
    return null;
  }
}

export function updateHighlights(
  sessionId: string,
  sendToClient: (msg: any) => void,
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

export function isScreencastActive(sessionId: string): boolean {
  return activeScreencasts.has(sessionId);
}

export { getSender };
