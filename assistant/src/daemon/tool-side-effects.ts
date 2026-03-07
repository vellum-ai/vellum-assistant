/**
 * Registry of per-tool post-execution side effects.
 *
 * Each entry maps one or more tool names to a handler that runs after
 * successful execution. This keeps the main tool executor callback
 * focused on orchestration — adding a new side effect is a single
 * registry entry instead of another if/else branch.
 */

import { join } from "node:path";

import { compileApp } from "../bundler/app-compiler.js";
import { generateAppIcon } from "../media/app-icon-generator.js";
import { getApp, getAppsDir, isMultifileApp } from "../memory/app-store.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { isDoordashCommand, updateDoordashProgress } from "./doordash-steps.js";
import type { ServerMessage } from "./ipc-protocol.js";
import { refreshSurfacesForApp } from "./session-surfaces.js";
import type { ToolSetupContext } from "./session-tool-setup.js";

const log = getLogger("tool-side-effects");

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

/** Shared logic for refreshing app surfaces, broadcasting changes, and triggering auto-deploy. */
function handleAppChange(
  ctx: ToolSetupContext,
  appId: string,
  broadcastToAllClients: ((msg: ServerMessage) => void) | undefined,
  opts?: { fileChange?: boolean; status?: string },
): void {
  const app = getApp(appId);

  // Multifile apps need a recompile before refreshing surfaces so the
  // WebView picks up the latest compiled output.
  if (app && isMultifileApp(app)) {
    const appDir = join(getAppsDir(), appId);
    void compileApp(appDir)
      .then((result) => {
        if (!result.ok) {
          log.warn(
            { appId, errors: result.errors },
            "Recompile failed on app change, serving stale dist/",
          );
        }
        refreshSurfacesForApp(ctx, appId, opts);
        broadcastToAllClients?.({ type: "app_files_changed", appId });
        void updatePublishedAppDeployment(appId);
      })
      .catch((err) => {
        log.warn({ appId, err }, "Recompile threw on app change");
        // Still refresh surfaces with stale output
        refreshSurfacesForApp(ctx, appId, opts);
        broadcastToAllClients?.({ type: "app_files_changed", appId });
        void updatePublishedAppDeployment(appId);
      });
    return;
  }

  refreshSurfacesForApp(ctx, appId, opts);
  broadcastToAllClients?.({ type: "app_files_changed", appId });
  void updatePublishedAppDeployment(appId);
}

// ── Registry ─────────────────────────────────────────────────────────

/**
 * Map of tool names to their post-execution side effect hooks.
 * Hooks only run when `result.isError` is false (checked by the runner).
 */
const postExecutionHooks = new Map<string, PostExecutionHook>();

function registerHook(
  toolNames: string | string[],
  hook: PostExecutionHook,
): void {
  const names = Array.isArray(toolNames) ? toolNames : [toolNames];
  for (const name of names) {
    postExecutionHooks.set(name, hook);
  }
}

// Broadcast app_files_changed when a new app is created so clients
// (e.g. macOS "Things" sidebar) refresh their app list immediately.
// Also kicks off async icon generation via Gemini.
registerHook(
  "app_create",
  (_name, _input, result, { ctx, broadcastToAllClients }) => {
    try {
      const parsed = JSON.parse(result.content) as {
        id?: string;
        name?: string;
        description?: string;
      };
      if (parsed.id) {
        handleAppChange(ctx, parsed.id, broadcastToAllClients);

        // Fire-and-forget: generate an app icon in the background.
        // When complete, broadcast again so clients pick up the new icon.
        if (parsed.name) {
          void generateAppIcon(parsed.id, parsed.name, parsed.description)
            .then(() => {
              broadcastToAllClients?.({
                type: "app_files_changed",
                appId: parsed.id!,
              });
            })
            .catch((err) => {
              log.warn(
                { err, appId: parsed.id },
                "Background icon generation failed",
              );
            });
        }
      }
    } catch {
      // Result wasn't valid JSON — skip the broadcast.
    }
  },
);

// Broadcast app_files_changed when an icon is (re)generated so clients refresh.
registerHook(
  "app_generate_icon",
  (_name, input, _result, { broadcastToAllClients }) => {
    const appId = input.app_id as string | undefined;
    if (appId) {
      broadcastToAllClients?.({ type: "app_files_changed", appId });
    }
  },
);

// Auto-refresh workspace surfaces when a persisted app is updated.
registerHook(
  "app_update",
  (_name, input, _result, { ctx, broadcastToAllClients }) => {
    const appId = input.app_id as string | undefined;
    if (appId) {
      handleAppChange(ctx, appId, broadcastToAllClients);
    }
  },
);

// Broadcast app_files_changed when an app is deleted so clients remove it
// from their cached app lists.
registerHook(
  "app_delete",
  (_name, input, _result, { broadcastToAllClients }) => {
    const appId = input.app_id as string | undefined;
    if (appId) {
      broadcastToAllClients?.({ type: "app_files_changed", appId });
    }
  },
);

// Broadcast tasks_changed so connected clients (e.g. macOS Tasks window)
// auto-refresh when the LLM mutates the task queue via tools
registerHook(
  ["task_list_add", "task_list_update", "task_list_remove", "task_queue_run"],
  (_name, _input, _result, { broadcastToAllClients }) => {
    broadcastToAllClients?.({ type: "tasks_changed" });
  },
);

// Auto-refresh workspace surfaces when app files are edited.
registerHook(
  ["app_file_edit", "app_file_write"],
  (_name, input, _result, { ctx, broadcastToAllClients }) => {
    const appId = input.app_id as string | undefined;
    const status = input.status as string | undefined;
    if (appId) {
      handleAppChange(ctx, appId, broadcastToAllClients, {
        fileChange: true,
        status,
      });
    }
  },
);

// Broadcast avatar change to all connected clients so every
// macOS/iOS instance reloads the avatar image.
registerHook(
  "set_avatar",
  (_name, _input, _result, { broadcastToAllClients }) => {
    const avatarPath = join(
      getWorkspaceDir(),
      "data",
      "avatar",
      "custom-avatar.png",
    );
    broadcastToAllClients?.({ type: "avatar_updated", avatarPath });
  },
);

// Broadcast voice config changes to all connected clients so every window
// picks up the updated UserDefaults value immediately.
registerHook(
  "voice_config_update",
  (_name, input, _result, { broadcastToAllClients }) => {
    const setting = input.setting as string | undefined;
    if (!setting) return;

    const SETTING_TO_KEY: Record<string, string> = {
      activation_key: "pttActivationKey",
      wake_word_enabled: "wakeWordEnabled",
      wake_word_keyword: "wakeWordKeyword",
      wake_word_timeout: "wakeWordTimeoutSeconds",
    };
    const key = SETTING_TO_KEY[setting];
    if (!key) return;

    // Coerce the value to the correct type before broadcasting, matching
    // the validation logic in the tool's execute method.
    const raw = input.value;
    let coerced: string | boolean | number = raw as string;
    if (setting === "wake_word_enabled") {
      coerced = raw === true || raw === "true";
    } else if (setting === "wake_word_timeout") {
      coerced = typeof raw === "number" ? raw : Number(raw);
    } else if (setting === "wake_word_keyword" && typeof raw === "string") {
      coerced = raw.trim();
    }
    broadcastToAllClients?.({
      type: "client_settings_update",
      key,
      value: coerced,
    } as unknown as ServerMessage);
  },
);

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
