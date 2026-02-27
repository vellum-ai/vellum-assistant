/**
 * Registry of per-tool post-execution side effects.
 *
 * Each entry maps one or more tool names to a handler that runs after
 * successful execution. This keeps the main tool executor callback
 * focused on orchestration — adding a new side effect is a single
 * registry entry instead of another if/else branch.
 */

import { updatePublishedAppDeployment } from '../services/published-app-updater.js';
import { openAppViaSurface } from '../tools/apps/open-proxy.js';
import type { ToolExecutionResult } from '../tools/types.js';
import { isDoordashCommand, updateDoordashProgress } from './doordash-steps.js';
import type { ServerMessage } from './ipc-protocol.js';
import {
  refreshSurfacesForApp,
  surfaceProxyResolver,
} from './session-surfaces.js';
import type { ToolSetupContext } from './session-tool-setup.js';

// ── Types ────────────────────────────────────────────────────────────

export interface SideEffectContext {
  ctx: ToolSetupContext;
  broadcastToAllClients?: (msg: ServerMessage) => void;
}

export type PostExecutionHook = (
  name: string,
  input: Record<string, unknown>,
  result: ToolExecutionResult,
  sideEffectCtx: SideEffectContext,
) => void;

// ── Helpers ──────────────────────────────────────────────────────────

/** Shared logic for refreshing app surfaces, broadcasting changes, and auto-opening. */
function handleAppChange(
  ctx: ToolSetupContext,
  appId: string,
  broadcastToAllClients: ((msg: ServerMessage) => void) | undefined,
  opts?: { fileChange?: boolean; status?: string },
): void {
  const refreshed = refreshSurfacesForApp(ctx, appId, opts);
  broadcastToAllClients?.({ type: 'app_files_changed', appId });
  void updatePublishedAppDeployment(appId);
  if (!refreshed && !ctx.hasNoClient && !ctx.headlessLock) {
    const resolver = (tn: string, pi: Record<string, unknown>) => surfaceProxyResolver(ctx, tn, pi);
    void openAppViaSurface(appId, resolver);
  }
}

// ── Registry ─────────────────────────────────────────────────────────

/**
 * Map of tool names to their post-execution side effect hooks.
 * Hooks only run when `result.isError` is false (checked by the runner).
 */
const postExecutionHooks = new Map<string, PostExecutionHook>();

function registerHook(toolNames: string | string[], hook: PostExecutionHook): void {
  const names = Array.isArray(toolNames) ? toolNames : [toolNames];
  for (const name of names) {
    postExecutionHooks.set(name, hook);
  }
}

// Auto-refresh workspace surfaces when a persisted app is updated.
// If no surface is currently showing the app, auto-open it.
registerHook('app_update', (_name, input, _result, { ctx, broadcastToAllClients }) => {
  const appId = input.app_id as string | undefined;
  if (appId) {
    handleAppChange(ctx, appId, broadcastToAllClients);
  }
});

// Broadcast tasks_changed so connected clients (e.g. macOS Tasks window)
// auto-refresh when the LLM mutates the task queue via tools
registerHook(
  ['task_list_add', 'task_list_update', 'task_list_remove', 'task_queue_run'],
  (_name, _input, _result, { broadcastToAllClients }) => {
    broadcastToAllClients?.({ type: 'tasks_changed' });
  },
);

// Auto-refresh workspace surfaces when app files are edited.
// If no surface is currently showing the app, auto-open it.
registerHook(
  ['app_file_edit', 'app_file_write'],
  (_name, input, _result, { ctx, broadcastToAllClients }) => {
    const appId = input.app_id as string | undefined;
    const status = input.status as string | undefined;
    if (appId) {
      handleAppChange(ctx, appId, broadcastToAllClients, { fileChange: true, status });
    }
  },
);

// Broadcast voice config changes to all connected clients so every window
// picks up the updated UserDefaults value immediately.
registerHook('voice_config_update', (_name, input, _result, { broadcastToAllClients }) => {
  const setting = (input.setting as string) ?? (input.activation_key ? 'activation_key' : undefined);
  if (!setting) return;

  const SETTING_TO_KEY: Record<string, string> = {
    activation_key: 'pttActivationKey',
    wake_word_enabled: 'wakeWordEnabled',
    wake_word_keyword: 'wakeWordKeyword',
    wake_word_timeout: 'wakeWordTimeoutSeconds',
  };
  const key = SETTING_TO_KEY[setting];
  if (!key) return;

  const value = input.value ?? input.activation_key;
  broadcastToAllClients?.({ type: 'client_settings_update', key, value } as unknown as ServerMessage);
});

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Run all applicable post-execution side effects for a completed tool call.
 * Handles both registry-based hooks and the DoorDash step tracker (which
 * uses its own name-matching logic).
 */
export function runPostExecutionSideEffects(
  name: string,
  input: Record<string, unknown>,
  result: ToolExecutionResult,
  sideEffectCtx: SideEffectContext,
): void {
  // Registry-based hooks only fire on success
  if (!result.isError) {
    const hook = postExecutionHooks.get(name);
    if (hook) {
      hook(name, input, result, sideEffectCtx);
    }
  }

  // DoorDash progress tracking fires on both success and failure
  if (isDoordashCommand(name, input)) {
    updateDoordashProgress(sideEffectCtx.ctx, input, result.isError);
  }
}
