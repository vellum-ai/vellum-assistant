import { v4 as uuid } from 'uuid';
import { INTERACTIVE_SURFACE_TYPES } from './ipc-protocol.js';
import type {
  ServerMessage,
  SurfaceType,
  SurfaceData,
  CardSurfaceData,
  DynamicPageSurfaceData,
  FileUploadSurfaceData,
  UiSurfaceShow,
} from './ipc-protocol.js';
import type { ToolExecutionResult } from '../tools/types.js';
import { getApp, updateApp } from '../memory/app-store.js';
import { getLogger } from '../util/logger.js';
import { buildSessionErrorMessage } from './session-error.js';
import {
  getPrebuiltHomeBasePreview,
  findSeededHomeBaseApp,
} from '../home-base/prebuilt/seed.js';

const log = getLogger('session-surfaces');

const MAX_UNDO_DEPTH = 10;
const TASK_PROGRESS_TEMPLATE_FIELDS = ['title', 'status', 'steps'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCardShowData(input: Record<string, unknown>, rawData: Record<string, unknown>): CardSurfaceData {
  const normalized: Record<string, unknown> = { ...rawData };

  // Older prompt examples sent template/templateData at the top level.
  if (typeof normalized.template !== 'string' && typeof input.template === 'string') {
    normalized.template = input.template;
  }
  if (!isPlainObject(normalized.templateData) && isPlainObject(input.templateData)) {
    normalized.templateData = input.templateData;
  }

  // task_progress cards need a title for Swift parsing; fall back when missing.
  if (normalized.template === 'task_progress' && typeof normalized.title !== 'string') {
    if (typeof input.title === 'string' && input.title.trim().length > 0) {
      normalized.title = input.title;
    } else if (isPlainObject(normalized.templateData) && typeof normalized.templateData.title === 'string') {
      normalized.title = normalized.templateData.title;
    } else {
      normalized.title = 'Task Progress';
    }
  }

  if (normalized.template === 'task_progress' && typeof normalized.body !== 'string') {
    normalized.body = '';
  }

  return normalized as unknown as CardSurfaceData;
}

function normalizeTaskProgressCardPatch(existingCard: CardSurfaceData, patch: Record<string, unknown>): Record<string, unknown> {
  if (existingCard.template !== 'task_progress') {
    return patch;
  }

  const normalizedPatch: Record<string, unknown> = { ...patch };
  const mergedTemplateData: Record<string, unknown> = isPlainObject(existingCard.templateData)
    ? { ...existingCard.templateData }
    : {};

  let updatedTemplateData = false;

  if (isPlainObject(normalizedPatch.templateData)) {
    Object.assign(mergedTemplateData, normalizedPatch.templateData);
    updatedTemplateData = true;
  }

  // Accept top-level task_progress fields from older prompt examples and
  // move them into templateData where the Swift client expects them.
  for (const key of TASK_PROGRESS_TEMPLATE_FIELDS) {
    if (key in normalizedPatch) {
      mergedTemplateData[key] = normalizedPatch[key];
      delete normalizedPatch[key];
      updatedTemplateData = true;
    }
  }

  if (updatedTemplateData) {
    normalizedPatch.templateData = mergedTemplateData;
  }

  return normalizedPatch;
}

/**
 * Subset of Session state that surface helpers need access to.
 * The Session class implements this interface so its instances can be
 * passed directly to the extracted functions.
 */
export interface SurfaceSessionContext {
  readonly conversationId: string;
  readonly traceEmitter: {
    emit(type: string, message: string, meta?: Record<string, unknown>): void;
  };
  sendToClient(msg: ServerMessage): void;
  pendingSurfaceActions: Map<string, { surfaceType: SurfaceType }>;
  lastSurfaceAction: Map<string, { actionId: string; data?: Record<string, unknown> }>;
  surfaceState: Map<string, { surfaceType: SurfaceType; data: SurfaceData }>;
  surfaceUndoStacks: Map<string, string[]>;
  currentTurnSurfaces: Array<{
    surfaceId: string;
    surfaceType: SurfaceType;
    title?: string;
    data: SurfaceData;
    actions?: Array<{ id: string; label: string; style?: string }>;
    display?: string;
  }>;
  onEscalateToComputerUse?: (task: string, sourceSessionId: string) => boolean;
  isProcessing(): boolean;
  enqueueMessage(
    content: string,
    attachments: never[],
    onEvent: (msg: ServerMessage) => void,
    requestId: string,
  ): { queued: boolean; rejected?: boolean; requestId: string };
  getQueueDepth(): number;
  processMessage(
    content: string,
    attachments: never[],
    onEvent: (msg: ServerMessage) => void,
    requestId?: string,
  ): Promise<string>;
}

/**
 * Handle content_changed action from document editor.
 * Auto-saves the document content to the app store.
 */
function handleDocumentContentChanged(
  ctx: SurfaceSessionContext,
  surfaceId: string,
  data?: Record<string, unknown>,
): void {
  if (!data) {
    log.warn({ surfaceId }, 'content_changed action missing data');
    return;
  }

  const { title, content, wordCount } = data as { title?: string; content?: string; wordCount?: number };

  if (!title && !content) {
    log.warn({ surfaceId }, 'content_changed action missing title or content');
    return;
  }

  // Find the app ID from the surface state
  const surfaceState = ctx.surfaceState.get(surfaceId);
  if (!surfaceState || surfaceState.surfaceType !== 'dynamic_page') {
    log.warn({ surfaceId }, 'Surface not found or not a dynamic page');
    return;
  }

  const dynamicPageData = surfaceState.data as DynamicPageSurfaceData;
  const appId = dynamicPageData.appId;

  if (!appId || !appId.startsWith('doc-')) {
    // Not a document app, ignore
    log.debug({ surfaceId, appId }, 'Not a document app, skipping auto-save');
    return;
  }

  try {
    const app = getApp(appId);
    if (!app) {
      log.warn({ appId }, 'Document app not found');
      return;
    }

    // Regenerate the editor HTML with updated content
    // We need to import the editor template dynamically
    import('../tools/document/editor-template.js').then(({ generateEditorHTML }) => {
      const updatedHtml = generateEditorHTML(
        title || app.name,
        content || '',
      );

      updateApp(appId, {
        name: title || app.name,
        description: `Document with ${wordCount ?? 0} words`,
        preview: content?.slice(0, 200),
        htmlDefinition: updatedHtml,
      });

      log.info({ appId, wordCount }, 'Document auto-saved');
    }).catch((err) => {
      log.error({ err, appId }, 'Failed to import editor template for auto-save');
    });
  } catch (err) {
    log.error({ err, appId }, 'Failed to auto-save document');
  }
}

export function pushUndoState(
  surfaceUndoStacks: Map<string, string[]>,
  surfaceId: string,
  html: string,
): void {
  let stack = surfaceUndoStacks.get(surfaceId);
  if (!stack) {
    stack = [];
    surfaceUndoStacks.set(surfaceId, stack);
  }
  stack.push(html);
  if (stack.length > MAX_UNDO_DEPTH) {
    stack.shift();
  }
}

export function handleSurfaceUndo(ctx: SurfaceSessionContext, surfaceId: string): void {
  const stack = ctx.surfaceUndoStacks.get(surfaceId);
  if (!stack || stack.length === 0) {
    ctx.sendToClient({
      type: 'ui_surface_undo_result',
      sessionId: ctx.conversationId,
      surfaceId,
      success: false,
      remainingUndos: 0,
    });
    return;
  }

  const previousHtml = stack.pop()!;
  const stored = ctx.surfaceState.get(surfaceId);
  if (!stored || stored.surfaceType !== 'dynamic_page') {
    ctx.sendToClient({
      type: 'ui_surface_undo_result',
      sessionId: ctx.conversationId,
      surfaceId,
      success: false,
      remainingUndos: stack.length,
    });
    return;
  }

  const data = stored.data as DynamicPageSurfaceData;

  // If app-backed, also revert the persisted app and refresh all surfaces for this app
  if (data.appId) {
    try {
      updateApp(data.appId, { htmlDefinition: previousHtml });
    } catch (err) {
      log.error({ appId: data.appId, err }, 'Failed to revert app during undo');
    }

    // Update ALL surfaces that share this appId (not just the requesting one)
    for (const [sid, s] of ctx.surfaceState.entries()) {
      if (s.surfaceType !== 'dynamic_page') continue;
      const sData = s.data as DynamicPageSurfaceData;
      if (sData.appId !== data.appId) continue;
      const revertedData: DynamicPageSurfaceData = { ...sData, html: previousHtml };
      s.data = revertedData;
      ctx.sendToClient({
        type: 'ui_surface_update',
        sessionId: ctx.conversationId,
        surfaceId: sid,
        data: revertedData,
      });
    }

    // Sync sibling undo stacks: pop the top entry if it matches the HTML we
    // just reverted to, preventing phantom no-op undo steps on siblings.
    for (const [sid, s] of ctx.surfaceState.entries()) {
      if (sid === surfaceId) continue;
      if (s.surfaceType !== 'dynamic_page') continue;
      const sData = s.data as DynamicPageSurfaceData;
      if (sData.appId !== data.appId) continue;

      const siblingStack = ctx.surfaceUndoStacks.get(sid);
      if (siblingStack && siblingStack.length > 0) {
        const top = siblingStack[siblingStack.length - 1];
        if (top === previousHtml) {
          siblingStack.pop();
        }
      }
    }
  } else {
    // Ephemeral surface — update only the requesting surface
    const revertedData: DynamicPageSurfaceData = { ...data, html: previousHtml };
    stored.data = revertedData;
    ctx.sendToClient({
      type: 'ui_surface_update',
      sessionId: ctx.conversationId,
      surfaceId,
      data: revertedData,
    });
  }

  ctx.sendToClient({
    type: 'ui_surface_undo_result',
    sessionId: ctx.conversationId,
    surfaceId,
    success: true,
    remainingUndos: stack.length,
  });

  log.info({ conversationId: ctx.conversationId, surfaceId, remaining: stack.length }, 'Surface undo applied');
}

export function handleSurfaceAction(ctx: SurfaceSessionContext, surfaceId: string, actionId: string, data?: Record<string, unknown>): void {
  const pending = ctx.pendingSurfaceActions.get(surfaceId);
  if (!pending) {
    log.warn({ surfaceId, actionId }, 'No pending surface action found');
    return;
  }
  const retainPending = pending.surfaceType === 'dynamic_page';
  // selection_changed is a non-terminal state update — don't consume the
  // pending entry or send a message.
  if (actionId === 'selection_changed') {
    log.debug({ surfaceId, data }, 'Selection changed (non-terminal, not forwarding)');
    return;
  }

  // content_changed is a non-terminal state update for document auto-save
  // Save the document content and don't forward to the session
  if (actionId === 'content_changed') {
    handleDocumentContentChanged(ctx, surfaceId, data);
    return;
  }
  ctx.lastSurfaceAction.set(surfaceId, { actionId, data });
  const shouldRelayPrompt = actionId === 'relay_prompt' || actionId === 'agent_prompt';
  const prompt =
    shouldRelayPrompt && typeof data?.prompt === 'string'
      ? data.prompt.trim()
      : '';
  const content = prompt || JSON.stringify({
    surfaceAction: true,
    surfaceId,
    surfaceType: pending.surfaceType,
    actionId,
    data: data ?? {},
  });

  const requestId = uuid();
  const onEvent = (msg: ServerMessage) => ctx.sendToClient(msg);

  // Echo the user's prompt to the client so it appears in the chat UI
  if (shouldRelayPrompt && prompt) {
    ctx.sendToClient({
      type: 'user_message_echo',
      text: prompt,
      sessionId: ctx.conversationId,
    });
  }

  ctx.traceEmitter.emit('request_received', 'Surface action received', {
    requestId,
    status: 'info',
    attributes: { source: 'surface_action', surfaceId, actionId },
  });

  const result = ctx.enqueueMessage(content, [], onEvent, requestId);
  if (result.queued) {
    const position = ctx.getQueueDepth();
    if (!retainPending) {
      ctx.pendingSurfaceActions.delete(surfaceId);
    }
    log.info({ surfaceId, actionId, requestId }, 'Surface action queued (session busy)');
    ctx.traceEmitter.emit('request_queued', `Surface action queued at position ${position}`, {
      requestId,
      status: 'info',
      attributes: { position },
    });
    onEvent({
      type: 'message_queued',
      sessionId: ctx.conversationId,
      requestId,
      position,
    });
    return;
  }

  if (result.rejected) {
    log.error({ surfaceId, actionId }, 'Surface action rejected — queue full');
    ctx.traceEmitter.emit('request_error', 'Surface action rejected — queue full', {
      requestId,
      status: 'error',
      attributes: { reason: 'queue_full', source: 'surface_action' },
    });
    onEvent(buildSessionErrorMessage(ctx.conversationId, {
      code: 'QUEUE_FULL',
      userMessage: 'Message queue is full (max depth: 10). Please wait for current messages to be processed.',
      retryable: true,
      debugDetails: 'Surface action rejected — session queue is full',
    }));
    return;
  }

  if (!retainPending) {
    ctx.pendingSurfaceActions.delete(surfaceId);
  }
  log.info({ surfaceId, actionId, requestId }, 'Processing surface action as follow-up');
  ctx.processMessage(content, [], onEvent, requestId).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, surfaceId, actionId }, 'Error processing surface action');
    onEvent({ type: 'error', message: `Failed to process surface action: ${message}` });
  });
}

/**
 * After an app_update, refresh any active surface that displays the updated app.
 */
export function refreshSurfacesForApp(ctx: SurfaceSessionContext, appId: string, opts?: { fileChange?: boolean; status?: string }): void {
  const app = getApp(appId);
  if (!app) return;

  for (const [surfaceId, stored] of ctx.surfaceState.entries()) {
    if (stored.surfaceType !== 'dynamic_page') continue;
    const data = stored.data as DynamicPageSurfaceData;
    if (data.appId !== appId) continue;

    // Push current HTML onto the undo stack before overwriting
    pushUndoState(ctx.surfaceUndoStacks, surfaceId, data.html);

    // Update in-memory surface state so the next refinement gets fresh HTML
    const updatedData: DynamicPageSurfaceData = {
      ...data,
      html: app.htmlDefinition,
      ...(opts?.fileChange ? { reloadGeneration: (data.reloadGeneration ?? 0) + 1 } : {}),
      ...(opts?.status !== undefined ? { status: opts.status } : {}),
    };
    stored.data = updatedData;

    // Push the update to the client
    ctx.sendToClient({
      type: 'ui_surface_update',
      sessionId: ctx.conversationId,
      surfaceId,
      data: updatedData,
    });

    log.info({ conversationId: ctx.conversationId, surfaceId, appId }, 'Auto-refreshed surface after app_update');
  }
}

export function buildCompletionSummary(surfaceType: string | undefined, actionId: string, data?: Record<string, unknown>): string {
  if (surfaceType === 'confirmation') {
    return actionId === 'cancel' ? 'Cancelled' : 'Confirmed';
  }
  if (surfaceType === 'form') {
    return 'Submitted';
  }
  if (surfaceType === 'list' && data) {
    const selectedIds = data.selectedIds as string[] | undefined;
    if (selectedIds?.length === 1) return `Selected: ${selectedIds[0]}`;
    if (selectedIds?.length) return `Selected ${selectedIds.length} items`;
  }
  if (surfaceType === 'table' && data) {
    const selectedIds = data.selectedIds as string[] | undefined;
    if (selectedIds?.length === 1) return `Selected 1 row`;
    if (selectedIds?.length) return `Selected ${selectedIds.length} rows`;
  }
  return actionId.charAt(0).toUpperCase() + actionId.slice(1);
}

/**
 * Resolve a proxy tool call that targets a UI surface.
 * Handles ui_show, ui_update, ui_dismiss, request_file, computer_use_request_control, and app_open.
 */
export async function surfaceProxyResolver(
  ctx: SurfaceSessionContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  if (toolName === 'request_file') {
    const surfaceId = uuid();
    const prompt = typeof input.prompt === 'string' ? input.prompt : 'Please share a file';
    const acceptedTypes = Array.isArray(input.accepted_types) ? input.accepted_types as string[] : undefined;
    const maxFiles = typeof input.max_files === 'number' ? input.max_files : 1;

    const data: FileUploadSurfaceData = {
      prompt,
      acceptedTypes,
      maxFiles,
    };

    ctx.surfaceState.set(surfaceId, { surfaceType: 'file_upload', data });

    ctx.sendToClient({
      type: 'ui_surface_show',
      sessionId: ctx.conversationId,
      surfaceId,
      surfaceType: 'file_upload',
      title: 'File Request',
      data,
    } as UiSurfaceShow);

    // Track surface for persistence
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType: 'file_upload',
      title: 'File Request',
      data,
    });

    // Non-blocking: return immediately, user action arrives as follow-up message
    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: 'file_upload' as SurfaceType });
    return {
      content: JSON.stringify({
        surfaceId,
        status: 'awaiting_user_action',
        message: 'File upload dialog displayed. The uploaded file data will arrive as a follow-up message.',
      }),
      isError: false,
    };
  }

  if (toolName === 'ui_show') {
    const surfaceId = uuid();
    const surfaceType = input.surface_type as SurfaceType;
    const title = typeof input.title === 'string' ? input.title : undefined;
    const rawData = isPlainObject(input.data) ? input.data : {};
    const data = (surfaceType === 'card'
      ? normalizeCardShowData(input, rawData)
      : rawData) as SurfaceData;
    const actions = input.actions as Array<{ id: string; label: string; style?: string }> | undefined;
    // Interactive surfaces default to awaiting user action.
    const hasActions = Array.isArray(actions) && actions.length > 0;
    const isInteractive = surfaceType === 'list'
      ? hasActions
      : surfaceType === 'table'
        ? hasActions
        : INTERACTIVE_SURFACE_TYPES.includes(surfaceType);
    const awaitAction = (input.await_action as boolean) ?? isInteractive;

    // Track surface state for ui_update merging
    ctx.surfaceState.set(surfaceId, { surfaceType, data });

    const display = (input.display as string) === 'panel' ? 'panel' : 'inline';

    const mappedActions = actions?.map(a => ({ id: a.id, label: a.label, style: (a.style ?? 'secondary') as 'primary' | 'secondary' | 'destructive' }));

    ctx.sendToClient({
      type: 'ui_surface_show',
      sessionId: ctx.conversationId,
      surfaceId,
      surfaceType,
      title,
      data,
      actions: mappedActions,
      display,
    } as unknown as UiSurfaceShow);

    // Track surface for persistence with the message
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType,
      title,
      data,
      actions: mappedActions,
      display,
    });

    if (awaitAction) {
      ctx.pendingSurfaceActions.set(surfaceId, { surfaceType });
      return {
        content: JSON.stringify({
          surfaceId,
          status: 'awaiting_user_action',
          message: 'Surface displayed. The user\'s response will arrive as a follow-up message.',
        }),
        isError: false,
      };
    }
    return { content: JSON.stringify({ surfaceId }), isError: false };
  }

  if (toolName === 'ui_update') {
    const surfaceId = input.surface_id as string;
    let patch = (isPlainObject(input.data) ? input.data : {}) as Record<string, unknown>;

    // Merge the partial patch into the stored full surface data
    const stored = ctx.surfaceState.get(surfaceId);
    let mergedData: SurfaceData;
    if (stored) {
      if (stored.surfaceType === 'card') {
        patch = normalizeTaskProgressCardPatch(stored.data as CardSurfaceData, patch);
      }
      // Push current HTML to undo stack for dynamic pages
      if (stored.surfaceType === 'dynamic_page') {
        const currentHtml = (stored.data as DynamicPageSurfaceData).html;
        pushUndoState(ctx.surfaceUndoStacks, surfaceId, currentHtml);
      }
      mergedData = { ...stored.data, ...patch } as SurfaceData;
      stored.data = mergedData;
    } else {
      mergedData = patch as unknown as SurfaceData;
    }

    ctx.sendToClient({
      type: 'ui_surface_update',
      sessionId: ctx.conversationId,
      surfaceId,
      data: mergedData,
    });
    return { content: 'Surface updated', isError: false };
  }

  if (toolName === 'ui_dismiss') {
    const surfaceId = input.surface_id as string;
    const lastAction = ctx.lastSurfaceAction.get(surfaceId);
    const stored = ctx.surfaceState.get(surfaceId);
    if (lastAction) {
      const summary = buildCompletionSummary(stored?.surfaceType, lastAction.actionId, lastAction.data);
      ctx.sendToClient({
        type: 'ui_surface_complete',
        sessionId: ctx.conversationId,
        surfaceId,
        summary,
        submittedData: lastAction.data,
      });
    } else {
      ctx.sendToClient({
        type: 'ui_surface_dismiss',
        sessionId: ctx.conversationId,
        surfaceId,
      });
    }
    ctx.pendingSurfaceActions.delete(surfaceId);
    ctx.surfaceState.delete(surfaceId);
    ctx.surfaceUndoStacks.delete(surfaceId);
    ctx.lastSurfaceAction.delete(surfaceId);
    return { content: lastAction ? 'Surface completed' : 'Surface dismissed', isError: false };
  }

  if (toolName === 'computer_use_request_control') {
    const task = typeof input.task === 'string' ? input.task : 'Perform the requested task';
    if (!ctx.onEscalateToComputerUse) {
      return {
        content: 'Computer control escalation is not available in this session.',
        isError: true,
      };
    }
    const success = ctx.onEscalateToComputerUse(task, ctx.conversationId);
    if (!success) {
      return {
        content: 'Computer control escalation failed — no active connection.',
        isError: true,
      };
    }
    return {
      content: 'Computer control activated. The task has been handed off to foreground computer use.',
      isError: false,
    };
  }

  if (toolName === 'app_open') {
    const appId = input.app_id as string;
    const preview = input.preview as DynamicPageSurfaceData['preview'];
    const app = getApp(appId);
    if (!app) return { content: `App not found: ${appId}`, isError: true };
    const seededHomeBase = findSeededHomeBaseApp();
    const defaultPreview = seededHomeBase && seededHomeBase.id === app.id
      ? getPrebuiltHomeBasePreview()
      : undefined;

    const surfaceData: DynamicPageSurfaceData = {
      html: app.htmlDefinition,
      appId: app.id,
      appType: app.appType,
      preview: preview ?? defaultPreview,
    };
    const surfaceId = uuid();
    ctx.surfaceState.set(surfaceId, {
      surfaceType: 'dynamic_page',
      data: surfaceData,
    });

    ctx.sendToClient({
      type: 'ui_surface_show',
      sessionId: ctx.conversationId,
      surfaceId,
      surfaceType: 'dynamic_page',
      title: app.name,
      data: surfaceData,
    } as UiSurfaceShow);

    // Track surface for persistence
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType: 'dynamic_page',
      title: app.name,
      data: surfaceData,
    });

    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: 'dynamic_page' });

    return { content: JSON.stringify({ surfaceId, appId }), isError: false };
  }

  return { content: `Unknown proxy tool: ${toolName}`, isError: true };
}
