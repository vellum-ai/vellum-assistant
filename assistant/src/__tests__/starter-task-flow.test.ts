import { describe, expect, mock, test } from 'bun:test';
import type { ServerMessage, SurfaceType } from '../daemon/ipc-protocol.js';

mock.module('../memory/app-store.js', () => ({
  getApp: (id: string) => {
    if (id !== 'home-base-app') return null;
    return {
      id,
      name: 'Home Base',
      appType: 'app',
      htmlDefinition: '<main id="home-base-root" data-vellum-home-base="v1"></main>',
    };
  },
  updateApp: () => {
    throw new Error('updateApp should not be called in this test');
  },
}));

mock.module('../home-base/prebuilt/seed.js', () => ({
  findSeededHomeBaseApp: () => ({ id: 'home-base-app' }),
  getPrebuiltHomeBasePreview: () => ({
    title: 'Home Base',
    subtitle: 'Dashboard',
    description: 'Preview',
    icon: '🏠',
    metrics: [{ label: 'Starter tasks', value: '3' }],
  }),
}));

import {
  handleSurfaceAction,
  surfaceProxyResolver,
  type SurfaceSessionContext,
} from '../daemon/session-surfaces.js';

function makeContext(): SurfaceSessionContext {
  return {
    conversationId: 'session-1',
    traceEmitter: {
      emit: () => {},
    },
    sendToClient: () => {},
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<string, { actionId: string; data?: Record<string, unknown> }>(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: 'req-1' }),
    getQueueDepth: () => 0,
    processMessage: async () => 'ok',
  };
}

describe('starter task surface actions', () => {
  test('keeps dynamic_page pending actions for repeated CTA clicks', () => {
    const ctx = makeContext();
    ctx.pendingSurfaceActions.set('surf-1', { surfaceType: 'dynamic_page' });

    handleSurfaceAction(ctx, 'surf-1', 'home_base_starter_change_look_and_feel', { accentColor: '#0b7e73' });

    expect(ctx.pendingSurfaceActions.has('surf-1')).toBe(true);
  });

  test('consumes non-dynamic pending actions after forwarding', () => {
    const ctx = makeContext();
    ctx.pendingSurfaceActions.set('confirm-1', { surfaceType: 'confirmation' });

    handleSurfaceAction(ctx, 'confirm-1', 'confirm', {});

    expect(ctx.pendingSurfaceActions.has('confirm-1')).toBe(false);
  });

  test('app_open registers dynamic_page surface as action-capable', async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext();
    ctx.sendToClient = (msg) => sent.push(msg);

    const result = await surfaceProxyResolver(ctx, 'app_open', {
      app_id: 'home-base-app',
    });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as { surfaceId: string; appId: string };
    expect(parsed.appId).toBe('home-base-app');
    expect(ctx.pendingSurfaceActions.get(parsed.surfaceId)?.surfaceType).toBe('dynamic_page');
    expect(sent.some((msg) => msg.type === 'ui_surface_show')).toBe(true);
  });
});
