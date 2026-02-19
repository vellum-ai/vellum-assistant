import * as net from 'node:net';
import type { ClientMessage } from '../ipc-protocol.js';
import { handleRideShotgunStart, handleRideShotgunStop } from '../ride-shotgun-handler.js';
import { handleWatchObservation } from '../watch-handler.js';
import { handleOpenBundle } from './open-bundle-handler.js';
import { log, pendingSignBundlePayload, pendingSigningIdentity, type HandlerContext } from './shared.js';
import { browserManager } from '../../tools/browser/browser-manager.js';

import {
  handleUserMessage,
  handleConfirmationResponse,
  handleSecretResponse,
  handleSessionList,
  handleSessionsClear,
  handleSessionCreate,
  handleSessionSwitch,
  handleCancel,
  handleDeleteQueuedMessage,
  handleHistoryRequest,
  handleUndo,
  handleRegenerate,
  handleUsageRequest,
  handleSandboxSet,
} from './sessions.js';

import {
  handleSkillsList,
  handleSkillDetail,
  handleSkillsEnable,
  handleSkillsDisable,
  handleSkillsConfigure,
  handleSkillsInstall,
  handleSkillsUninstall,
  handleSkillsUpdate,
  handleSkillsCheckUpdates,
  handleSkillsSearch,
  handleSkillsInspect,
} from './skills.js';

import {
  handleAppDataRequest,
  handleAppOpenRequest,
  handleAppUpdatePreview,
  handleAppPreview,
  handleAppsList,
  handleSharedAppsList,
  handleSharedAppDelete,
  handleForkSharedApp,
  handleShareAppCloud,
  handleBundleApp,
  handleGalleryList,
  handleGalleryInstall,
} from './apps.js';

import {
  handleModelGet,
  handleModelSet,
  handleImageGenModelSet,
  handleAddTrustRule,
  handleTrustRulesList,
  handleRemoveTrustRule,
  handleUpdateTrustRule,
  handleAcceptStarterBundle,
  handleSchedulesList,
  handleScheduleToggle,
  handleScheduleRemove,
  handleRemindersList,
  handleReminderCancel,
  handleShareToSlack,
  handleSlackWebhookConfig,
  handleVercelApiConfig,
  handleEnvVarsRequest,
} from './config.js';

import {
  handleCuSessionCreate,
  handleCuSessionAbort,
  handleCuObservation,
} from './computer-use.js';

import {
  handlePublishPage,
  handleUnpublishPage,
} from './publish.js';
import { handleHomeBaseGet } from './home-base.js';
import { handleDiagnosticsExport } from './diagnostics.js';

import {
  handleTaskSubmit,
  handleSuggestionRequest,
  handleLinkOpenRequest,
  handleIpcBlobProbe,
} from './misc.js';

import {
  handleDocumentSave,
  handleDocumentLoad,
  handleDocumentList,
} from './documents.js';

import {
  handleWorkItemsList,
  handleWorkItemGet,
  handleWorkItemCreate,
  handleWorkItemUpdate,
  handleWorkItemComplete,
  handleWorkItemDelete,
  handleWorkItemRunTask,
  handleWorkItemOutput,
  handleWorkItemPreflight,
  handleWorkItemApprovePermissions,
} from './work-items.js';

import {
  handleSubagentAbort,
  handleSubagentStatus,
  handleSubagentMessage,
} from './subagents.js';

// Re-export types and utilities for backwards compatibility
export type {
  HandlerContext,
  SessionCreateOptions,
  HistoryToolCall,
  HistorySurface,
  RenderedHistoryContent,
  ParsedHistoryMessage,
} from './shared.js';

export {
  renderHistoryContent,
  mergeToolResults,
} from './shared.js';

// ─── Typed dispatch ──────────────────────────────────────────────────────────

type MessageType = ClientMessage['type'];
// 'auth' is handled at the transport layer (server.ts) and never reaches dispatch.
type DispatchableType = Exclude<MessageType, 'auth'>;
type MessageOfType<T extends MessageType> = Extract<ClientMessage, { type: T }>;
type MessageHandler<T extends MessageType> = (
  msg: MessageOfType<T>,
  socket: net.Socket,
  ctx: HandlerContext,
) => void | Promise<void>;
type DispatchMap = { [T in DispatchableType]: MessageHandler<T> };

const handlers: DispatchMap = {
  user_message: handleUserMessage,
  confirmation_response: handleConfirmationResponse,
  secret_response: handleSecretResponse,
  session_list: (_msg, socket, ctx) => handleSessionList(socket, ctx),
  session_create: handleSessionCreate,
  sessions_clear: (_msg, socket, ctx) => handleSessionsClear(socket, ctx),
  session_switch: handleSessionSwitch,
  cancel: handleCancel,
  delete_queued_message: handleDeleteQueuedMessage,
  model_get: (_msg, socket, ctx) => handleModelGet(socket, ctx),
  model_set: handleModelSet,
  image_gen_model_set: handleImageGenModelSet,
  history_request: handleHistoryRequest,
  undo: handleUndo,
  regenerate: handleRegenerate,
  usage_request: handleUsageRequest,
  sandbox_set: handleSandboxSet,
  cu_session_create: handleCuSessionCreate,
  cu_session_abort: handleCuSessionAbort,
  cu_observation: handleCuObservation,
  ride_shotgun_start: handleRideShotgunStart,
  ride_shotgun_stop: handleRideShotgunStop,
  watch_observation: handleWatchObservation,
  task_submit: handleTaskSubmit,
  app_data_request: handleAppDataRequest,
  skills_list: (_msg, socket, ctx) => handleSkillsList(socket, ctx),
  skill_detail: handleSkillDetail,
  skills_enable: handleSkillsEnable,
  skills_disable: handleSkillsDisable,
  skills_configure: handleSkillsConfigure,
  skills_install: handleSkillsInstall,
  skills_uninstall: handleSkillsUninstall,
  skills_update: handleSkillsUpdate,
  skills_check_updates: handleSkillsCheckUpdates,
  skills_search: handleSkillsSearch,
  skills_inspect: handleSkillsInspect,
  suggestion_request: handleSuggestionRequest,
  add_trust_rule: handleAddTrustRule,
  trust_rules_list: (_msg, socket, ctx) => handleTrustRulesList(socket, ctx),
  remove_trust_rule: handleRemoveTrustRule,
  update_trust_rule: handleUpdateTrustRule,
  accept_starter_bundle: (_msg, socket, ctx) => handleAcceptStarterBundle(socket, ctx),
  schedules_list: (_msg, socket, ctx) => handleSchedulesList(socket, ctx),
  schedule_toggle: handleScheduleToggle,
  schedule_remove: handleScheduleRemove,
  reminders_list: (_msg, socket, ctx) => handleRemindersList(socket, ctx),
  reminder_cancel: handleReminderCancel,
  share_app_cloud: handleShareAppCloud,
  bundle_app: handleBundleApp,
  open_bundle: handleOpenBundle,
  app_open_request: (msg, socket, ctx) => handleAppOpenRequest(msg, socket, ctx),
  app_update_preview: handleAppUpdatePreview,
  apps_list: (_msg, socket, ctx) => handleAppsList(socket, ctx),
  app_preview_request: handleAppPreview,
  home_base_get: handleHomeBaseGet,
  shared_apps_list: (_msg, socket, ctx) => handleSharedAppsList(socket, ctx),
  shared_app_delete: handleSharedAppDelete,
  fork_shared_app: handleForkSharedApp,
  sign_bundle_payload_response: (msg) => {
    const pending = pendingSignBundlePayload.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingSignBundlePayload.delete(msg.requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else if (msg.signature && msg.keyId && msg.publicKey) {
        pending.resolve({ signature: msg.signature, keyId: msg.keyId, publicKey: msg.publicKey });
      } else {
        pending.reject(new Error('Missing required fields in sign_bundle_payload_response'));
      }
    } else {
      log.warn({ requestId: msg.requestId }, 'Received sign_bundle_payload_response with no pending request');
    }
  },
  get_signing_identity_response: (msg) => {
    const pending = pendingSigningIdentity.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingSigningIdentity.delete(msg.requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else if (msg.keyId && msg.publicKey) {
        pending.resolve({ keyId: msg.keyId, publicKey: msg.publicKey });
      } else {
        pending.reject(new Error('Missing required fields in get_signing_identity_response'));
      }
    } else {
      log.warn({ requestId: msg.requestId }, 'Received get_signing_identity_response with no pending request');
    }
  },
  gallery_list: (_msg, socket, ctx) => handleGalleryList(socket, ctx),
  gallery_install: handleGalleryInstall,
  share_to_slack: handleShareToSlack,
  slack_webhook_config: handleSlackWebhookConfig,
  vercel_api_config: handleVercelApiConfig,
  publish_page: handlePublishPage,
  unpublish_page: handleUnpublishPage,
  ping: (_msg, socket, ctx) => { ctx.send(socket, { type: 'pong' }); },
  link_open_request: handleLinkOpenRequest,
  ipc_blob_probe: handleIpcBlobProbe,
  ui_surface_action: (msg, _socket, ctx) => {
    const cuSession = ctx.cuSessions.get(msg.sessionId);
    if (cuSession) {
      cuSession.handleSurfaceAction(msg.surfaceId, msg.actionId, msg.data);
      return;
    }
    const session = ctx.sessions.get(msg.sessionId);
    if (session) {
      ctx.touchSession(msg.sessionId);
      session.handleSurfaceAction(msg.surfaceId, msg.actionId, msg.data);
      return;
    }
    log.warn({ sessionId: msg.sessionId, surfaceId: msg.surfaceId }, 'No session found for surface action');
  },
  ui_surface_undo: (msg, _socket, ctx) => {
    const session = ctx.sessions.get(msg.sessionId);
    if (session) {
      ctx.touchSession(msg.sessionId);
      session.handleSurfaceUndo(msg.surfaceId);
      return;
    }
    log.warn({ sessionId: msg.sessionId, surfaceId: msg.surfaceId }, 'No session found for surface undo');
  },
  diagnostics_export_request: handleDiagnosticsExport,
  env_vars_request: (_msg, socket, ctx) => handleEnvVarsRequest(socket, ctx),
  document_save: handleDocumentSave,
  document_load: handleDocumentLoad,
  document_list: handleDocumentList,

  browser_cdp_response: (msg) => {
    browserManager.resolveCDPResponse(msg.sessionId, msg.success, msg.declined);
  },

  // Stub handlers: the integration registry was removed but the Swift client
  // still sends these messages. Return safe no-op responses so the client
  // doesn't hang waiting for a reply.
  integration_list: (_msg, socket, ctx) => {
    ctx.send(socket, { type: 'integration_list_response', integrations: [] });
  },
  integration_connect: (msg, socket, ctx) => {
    ctx.send(socket, {
      type: 'integration_connect_result',
      integrationId: msg.integrationId,
      success: false,
      error: 'Please use chat to connect integrations.',
    });
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

  integration_disconnect: () => { /* no-op — integration registry removed */ },

  work_items_list: handleWorkItemsList,
  work_item_get: handleWorkItemGet,
  work_item_create: handleWorkItemCreate,
  work_item_update: handleWorkItemUpdate,
  work_item_complete: handleWorkItemComplete,
  work_item_delete: handleWorkItemDelete,
  work_item_run_task: handleWorkItemRunTask,
  work_item_output: handleWorkItemOutput,
  work_item_preflight: handleWorkItemPreflight,
  work_item_approve_permissions: handleWorkItemApprovePermissions,

  subagent_abort: handleSubagentAbort,
  subagent_status: handleSubagentStatus,
  subagent_message: handleSubagentMessage,
};

export function handleMessage(
  msg: ClientMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // 'auth' is handled at the transport layer and should never reach dispatch.
  if (msg.type === 'auth') return;

  const handler = handlers[msg.type] as
    | ((msg: ClientMessage, socket: net.Socket, ctx: HandlerContext) => void)
    | undefined;
  if (!handler) {
    log.warn({ type: msg.type }, 'Unknown message type, ignoring');
    return;
  }
  handler(msg, socket, ctx);
}
