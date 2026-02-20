import * as net from 'node:net';
import type { HomeBaseGetRequest } from '../ipc-protocol.js';
import { bootstrapHomeBaseAppLink, resolveHomeBaseAppId } from '../../home-base/bootstrap.js';
import {
  getPrebuiltHomeBasePreview,
  getPrebuiltHomeBaseTaskPayload,
} from '../../home-base/prebuilt/seed.js';
import { getHomeBaseAppLink } from '../../home-base/app-link-store.js';
import { getApp } from '../../memory/app-store.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

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

    const link = getHomeBaseAppLink();
    const source = link?.source ?? 'prebuilt_seed';

    let preview: {
      title: string;
      subtitle: string;
      description: string;
      icon: string;
      metrics: Array<{ label: string; value: string }>;
    };

    if (source === 'personalized') {
      const app = getApp(appId);
      if (app) {
        preview = {
          title: app.name,
          subtitle: 'Dashboard',
          description: app.description ?? '',
          icon: app.icon ?? '🏠',
          metrics: [],
        };
      } else {
        preview = getPrebuiltHomeBasePreview();
      }
    } else {
      preview = getPrebuiltHomeBasePreview();
    }

    const tasks = getPrebuiltHomeBaseTaskPayload();

    ctx.send(socket, {
      type: 'home_base_get_response',
      homeBase: {
        appId,
        source,
        starterTasks: tasks.starterTasks,
        onboardingTasks: tasks.onboardingTasks,
        preview,
      },
    });
  } catch (err) {
    log.error({ err }, 'Failed to resolve home base metadata');
    // Return null rather than surfacing an error banner to the user —
    // the chat still works fine without home base metadata.
    ctx.send(socket, { type: 'home_base_get_response', homeBase: null });
  }
}

export const homeBaseHandlers = defineHandlers({
  home_base_get: handleHomeBaseGet,
});
