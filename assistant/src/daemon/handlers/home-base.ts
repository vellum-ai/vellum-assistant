import * as net from 'node:net';
import type { HomeBaseGetRequest } from '../ipc-protocol.js';
import { bootstrapHomeBaseAppLink, resolveHomeBaseAppId } from '../../home-base/bootstrap.js';
import {
  getPrebuiltHomeBasePreview,
  getPrebuiltHomeBaseTaskPayload,
} from '../../home-base/prebuilt/seed.js';
import { getHomeBaseAppLink } from '../../home-base/app-link-store.js';
import { log, type HandlerContext } from './shared.js';

export function handleHomeBaseGet(
  msg: HomeBaseGetRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (msg.ensureLinked !== false) {
      bootstrapHomeBaseAppLink();
    }

    const appId = resolveHomeBaseAppId();
    if (!appId) {
      ctx.send(socket, { type: 'home_base_get_response', homeBase: null });
      return;
    }

    const tasks = getPrebuiltHomeBaseTaskPayload();
    const preview = getPrebuiltHomeBasePreview();
    const link = getHomeBaseAppLink();

    ctx.send(socket, {
      type: 'home_base_get_response',
      homeBase: {
        appId,
        source: link?.source ?? 'prebuilt_seed',
        starterTasks: tasks.starterTasks,
        onboardingTasks: tasks.onboardingTasks,
        preview,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to resolve home base metadata');
    ctx.send(socket, { type: 'error', message: `Failed to resolve home base metadata: ${message}` });
  }
}
