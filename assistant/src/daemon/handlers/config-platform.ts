import * as net from 'node:net';

import { loadRawConfig, saveRawConfig } from '../../config/loader.js';
import type { PlatformConfigRequest } from '../ipc-protocol.js';
import { CONFIG_RELOAD_DEBOUNCE_MS, defineHandlers, type HandlerContext,log } from './shared.js';

export async function handlePlatformConfig(
  msg: PlatformConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (msg.action === 'get') {
      const raw = loadRawConfig();
      const platform = (raw?.platform ?? {}) as Record<string, unknown>;
      const baseUrl = (platform.baseUrl as string) ?? '';
      ctx.send(socket, { type: 'platform_config_response', baseUrl, success: true });
    } else if (msg.action === 'set') {
      const value = (msg.baseUrl ?? '').trim().replace(/\/+$/, '');
      const raw = loadRawConfig();
      const platform = (raw?.platform ?? {}) as Record<string, unknown>;
      platform.baseUrl = value || undefined;

      const wasSuppressed = ctx.suppressConfigReload;
      ctx.setSuppressConfigReload(true);
      try {
        saveRawConfig({ ...raw, platform });
      } catch (err) {
        ctx.setSuppressConfigReload(wasSuppressed);
        throw err;
      }
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      log.info({ baseUrl: value || '(default)' }, 'Platform base URL updated');
      ctx.send(socket, { type: 'platform_config_response', baseUrl: value, success: true });
    } else {
      ctx.send(socket, {
        type: 'platform_config_response',
        baseUrl: '',
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Platform config handler failed');
    ctx.send(socket, { type: 'platform_config_response', baseUrl: '', success: false, error: message });
  }
}

export const platformHandlers = defineHandlers({
  platform_config: handlePlatformConfig,
});
