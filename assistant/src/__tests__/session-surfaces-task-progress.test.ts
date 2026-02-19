import { describe, expect, test } from 'bun:test';
import type {
  CardSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
  UiSurfaceUpdate,
} from '../daemon/ipc-protocol.js';
import {
  surfaceProxyResolver,
  type SurfaceSessionContext,
} from '../daemon/session-surfaces.js';

function makeContext(sent: ServerMessage[] = []): SurfaceSessionContext {
  return {
    conversationId: 'session-1',
    traceEmitter: { emit: () => {} },
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<string, { actionId: string; data?: Record<string, unknown> }>(),
    surfaceState: new Map<string, { surfaceType: SurfaceType; data: SurfaceData }>(),
    surfaceUndoStacks: new Map<string, string[]>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: 'req-1' }),
    getQueueDepth: () => 0,
    processMessage: async () => 'ok',
  };
}

describe('task_progress surface compatibility', () => {
  test('ui_show maps legacy top-level task_progress fields into card data', async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, 'ui_show', {
      surface_type: 'card',
      title: 'Ordering from DoorDash',
      data: {},
      template: 'task_progress',
      templateData: {
        status: 'in_progress',
        steps: [
          { label: 'Search restaurants', status: 'in_progress' },
          { label: 'Browse menu', status: 'pending' },
        ],
      },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find((msg): msg is UiSurfaceShow => msg.type === 'ui_surface_show');
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== 'card') return;

    const card = showMessage.data as CardSurfaceData;
    expect(card.template).toBe('task_progress');
    expect(card.title).toBe('Ordering from DoorDash');
    expect(card.body).toBe('');
    expect((card.templateData as Record<string, unknown>).status).toBe('in_progress');
  });

  test('ui_update normalizes top-level task_progress fields into templateData', async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);
    const existingCard: CardSurfaceData = {
      title: 'Ordering from DoorDash',
      body: '',
      template: 'task_progress',
      templateData: {
        title: 'Ordering from DoorDash',
        status: 'in_progress',
        steps: [
          { label: 'Search restaurants', status: 'completed' },
          { label: 'Browse menu', status: 'in_progress' },
          { label: 'Add to cart', status: 'pending' },
        ],
      },
    };

    ctx.surfaceState.set('surface-1', { surfaceType: 'card', data: existingCard });

    const result = await surfaceProxyResolver(ctx, 'ui_update', {
      surface_id: 'surface-1',
      data: {
        status: 'completed',
      },
    });

    expect(result.isError).toBe(false);

    const updateMessage = sent.find((msg): msg is UiSurfaceUpdate => msg.type === 'ui_surface_update');
    expect(updateMessage).toBeDefined();
    if (!updateMessage) return;

    const updatedCard = updateMessage.data as CardSurfaceData & Record<string, unknown>;
    expect(updatedCard.template).toBe('task_progress');
    expect('status' in updatedCard).toBe(false);
    const templateData = updatedCard.templateData as Record<string, unknown>;
    expect(templateData.status).toBe('completed');
    expect(Array.isArray(templateData.steps)).toBe(true);
  });
});
