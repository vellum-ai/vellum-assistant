import { browserManager } from '../../tools/browser/browser-manager.js';
import { log, type DispatchMap } from './shared.js';

export const browserHandlers: Partial<DispatchMap> = {
  browser_cdp_response: (msg) => {
    browserManager.resolveCDPResponse(msg.sessionId, msg.success, msg.declined);
  },

  browser_user_click: async (msg) => {
    try {
      const page = await browserManager.getOrCreateSessionPage(msg.sessionId);
      const viewport = await page.evaluate('(() => ({ vw: window.innerWidth, vh: window.innerHeight }))()') as { vw: number; vh: number };
      const scale = Math.min(1280 / viewport.vw, 960 / viewport.vh);
      const pageX = msg.x / scale;
      const pageY = msg.y / scale;
      const options: Record<string, unknown> = {};
      if (msg.button === 'right') options.button = 'right';
      if (msg.doubleClick) options.clickCount = 2;
      await page.mouse.click(pageX, pageY, options);
    } catch (err) {
      log.warn({ err, sessionId: msg.sessionId }, 'Failed to forward user click');
    }
  },

  browser_user_scroll: async (msg) => {
    try {
      const page = await browserManager.getOrCreateSessionPage(msg.sessionId);
      await page.mouse.wheel(msg.deltaX, msg.deltaY);
    } catch (err) {
      log.warn({ err, sessionId: msg.sessionId }, 'Failed to forward user scroll');
    }
  },

  browser_user_keypress: async (msg) => {
    try {
      const page = await browserManager.getOrCreateSessionPage(msg.sessionId);
      const combo = msg.modifiers?.length ? [...msg.modifiers, msg.key].join('+') : msg.key;
      await page.keyboard.press(combo);
    } catch (err) {
      log.warn({ err, sessionId: msg.sessionId }, 'Failed to forward user keypress');
    }
  },

  browser_interactive_mode: (msg, socket, ctx) => {
    log.info({ sessionId: msg.sessionId, enabled: msg.enabled }, 'Interactive mode toggled');
    browserManager.setInteractiveMode(msg.sessionId, msg.enabled);
    ctx.send(socket, {
      type: 'browser_interactive_mode_changed',
      sessionId: msg.sessionId,
      surfaceId: msg.surfaceId,
      enabled: msg.enabled,
    });
  },
};
