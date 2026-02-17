import * as net from 'node:net';
import type { ClientMessage } from '../ipc-protocol.js';
import type { IntegrationConnectRequest, IntegrationDisconnectRequest } from '../ipc-contract.js';
import { handleRideShotgunStart } from '../ride-shotgun-handler.js';
import { handleWatchObservation } from '../watch-handler.js';
import { handleOpenBundle } from './open-bundle-handler.js';
import { log, pendingSignBundlePayload, pendingSigningIdentity, type HandlerContext } from './shared.js';

import {
  handleUserMessage,
  handleConfirmationResponse,
  handleSecretResponse,
  handleSessionList,
  handleSessionsClear,
  handleSessionCreate,
  handleSessionSwitch,
  handleCancel,
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
  handleAddTrustRule,
  handleTrustRulesList,
  handleRemoveTrustRule,
  handleUpdateTrustRule,
  handleSchedulesList,
  handleScheduleToggle,
  handleScheduleRemove,
  handleRemindersList,
  handleReminderCancel,
  handleShareToSlack,
  handleSlackWebhookConfig,
  handleVercelApiConfig,
  handleIntegrationList,
  handleIntegrationConnect,
  handleIntegrationDisconnect,
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

import {
  handleTaskSubmit,
  handleSuggestionRequest,
  handleLinkOpenRequest,
  handleIpcBlobProbe,
} from './misc.js';

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
  model_get: (_msg, socket, ctx) => handleModelGet(socket, ctx),
  model_set: handleModelSet,
  history_request: handleHistoryRequest,
  undo: handleUndo,
  regenerate: handleRegenerate,
  usage_request: handleUsageRequest,
  sandbox_set: handleSandboxSet,
  cu_session_create: handleCuSessionCreate,
  cu_session_abort: handleCuSessionAbort,
  cu_observation: handleCuObservation,
  ride_shotgun_start: handleRideShotgunStart,
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
  home_base_get: handleHomeBaseGet,
  shared_apps_list: (_msg, socket, ctx) => handleSharedAppsList(socket, ctx),
  shared_app_delete: handleSharedAppDelete,
  fork_shared_app: handleForkSharedApp,
  sign_bundle_payload_response: (msg, socket) => {
    const pending = pendingSignBundlePayload.get(socket);
    if (pending) {
      clearTimeout(pending.timer);
      pendingSignBundlePayload.delete(socket);
      pending.resolve({ signature: msg.signature, keyId: msg.keyId, publicKey: msg.publicKey });
    } else {
      log.warn('Received sign_bundle_payload_response with no pending request');
    }
  },
  get_signing_identity_response: (msg, socket) => {
    const pending = pendingSigningIdentity.get(socket);
    if (pending) {
      clearTimeout(pending.timer);
      pendingSigningIdentity.delete(socket);
      pending.resolve({ keyId: msg.keyId, publicKey: msg.publicKey });
    } else {
      log.warn('Received get_signing_identity_response with no pending request');
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
      session.handleSurfaceAction(msg.surfaceId, msg.actionId, msg.data);
      return;
    }
    log.warn({ sessionId: msg.sessionId, surfaceId: msg.surfaceId }, 'No session found for surface action');
  },
  ui_surface_undo: (msg, _socket, ctx) => {
    const session = ctx.sessions.get(msg.sessionId);
    if (session) {
      session.handleSurfaceUndo(msg.surfaceId);
      return;
    }
    log.warn({ sessionId: msg.sessionId, surfaceId: msg.surfaceId }, 'No session found for surface undo');
  },
  integration_list: (_msg, socket, ctx) => {
    handleIntegrationList(socket, ctx);
  },
  integration_connect: (msg, socket, ctx) => {
    handleIntegrationConnect(msg as IntegrationConnectRequest, socket, ctx);
  },
  integration_disconnect: (msg, socket, ctx) => {
    handleIntegrationDisconnect(msg as IntegrationDisconnectRequest, socket, ctx);
  },
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
