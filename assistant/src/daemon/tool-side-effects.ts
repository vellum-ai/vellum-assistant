/**
 * Registry of per-tool post-execution side effects.
 *
 * Each entry maps one or more tool names to a handler that runs after
 * successful execution. This keeps the main tool executor callback
 * focused on orchestration — adding a new side effect is a single
 * registry entry instead of another if/else branch.
 */

import { generateAppIcon } from "../media/app-icon-generator.js";
import { findActiveSession } from "../runtime/channel-verification-service.js";
import { deliverVerificationSlack } from "../runtime/verification-outbound-actions.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { ensureAppSourceWatcher } from "./app-source-watcher.js";
import { refreshSurfacesForApp } from "./conversation-surfaces.js";
import type { ToolSetupContext } from "./conversation-tool-setup.js";
import { isDoordashCommand, updateDoordashProgress } from "./doordash-steps.js";
import type { ServerMessage } from "./message-protocol.js";

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

/**
 * Propagate an app change to connected clients and the publish pipeline.
 *
 * Compilation is the responsibility of the tool executor (see
 * `executeAppCreate`, `executeAppRefresh`): executors own the source→dist
 * transform and surface `compile_errors` in their result when it fails.
 * Post-execution hooks only observe the outcome and notify — they must
 * not re-run a compile because `compileApp()` begins with `rm -rf dist/`
 * and would race with the executor's own output (LUM-1153).
 */
function notifyAppChanged(
  ctx: ToolSetupContext,
  appId: string,
  broadcastToAllClients: ((msg: ServerMessage) => void) | undefined,
  opts?: { fileChange?: boolean; status?: string },
): void {
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
        // The apps directory may have just been created — ensure the
        // filesystem watcher is running so subsequent file edits
        // trigger live reload.
        ensureAppSourceWatcher();

        notifyAppChanged(ctx, parsed.id, broadcastToAllClients);

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

// Trigger surface refresh + broadcast when an app is refreshed.
registerHook(
  "app_refresh",
  (_name, input, _result, { ctx, broadcastToAllClients }) => {
    const appId = input.app_id as string | undefined;
    if (!appId) return;
    notifyAppChanged(ctx, appId, broadcastToAllClients, { fileChange: true });
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
      tts_voice_id: "ttsVoiceId",
      tts_provider: "ttsProvider",
      conversation_timeout: "voiceConversationTimeoutSeconds",
      fish_audio_reference_id: "fishAudioReferenceId",
    };
    const key = SETTING_TO_KEY[setting];
    if (!key) return;

    // Coerce the value to the correct type before broadcasting, matching
    // the validation logic in the tool's execute method.
    const raw = input.value;
    let coerced: string | boolean | number = raw as string;
    if (setting === "conversation_timeout") {
      coerced = typeof raw === "number" ? raw : Number(raw);
    } else if (setting === "tts_voice_id" && typeof raw === "string") {
      coerced = raw.trim();
    } else if (
      setting === "fish_audio_reference_id" &&
      typeof raw === "string"
    ) {
      coerced = raw.trim();
    } else if (setting === "tts_provider" && typeof raw === "string") {
      coerced = raw.trim();
    }
    broadcastToAllClients?.({
      type: "client_settings_update",
      key,
      value: coerced,
    } as unknown as ServerMessage);
  },
);

// Dispatch pending Slack DM delivery when a CLI verification command
// completes.  The CLI subprocess is sandboxed and cannot reach the
// gateway, so it includes a `_pendingSlackDm` field in its JSON output.
// This hook runs in the unsandboxed daemon process and delivers the DM.
registerHook("bash", (_name, input, result) => {
  const command = (input.command ?? "") as string;
  if (!command.includes("channel-verification-sessions")) return;
  if (!result.content.includes("_pendingSlackDm")) return;

  type PendingDm = { userId: string; text: string; assistantId: string };
  type Parsed = { _pendingSlackDm?: PendingDm };

  // Returns "delivered" when DM was sent, "rejected" when _pendingSlackDm
  // was found but failed validation, or null when the field was absent.
  const dispatch = (parsed: Parsed): "delivered" | "rejected" | null => {
    if (parsed._pendingSlackDm) {
      const { userId, text, assistantId } = parsed._pendingSlackDm;

      // Validate that an active Slack verification session exists and
      // that the destination matches the userId in the parsed payload.
      const session = findActiveSession("slack");
      if (!session) {
        log.warn(
          { userId, assistantId },
          "Bash hook: no active Slack verification session — ignoring _pendingSlackDm",
        );
        return "rejected";
      }
      if (session.destinationAddress !== userId) {
        log.warn(
          { userId, expected: session.destinationAddress, assistantId },
          "Bash hook: Slack DM userId does not match active session destination — ignoring",
        );
        return "rejected";
      }

      deliverVerificationSlack(userId, text, assistantId);
      return "delivered";
    }
    return null;
  };

  // Try full content first (handles pretty-printed single-object JSON)
  try {
    if (dispatch(JSON.parse(result.content.trim()) as Parsed) !== null) return;
  } catch {
    // Not a single JSON object — fall back to line-by-line for
    // multi-object output (e.g. cancel + create chained with &&).
  }
  for (const line of result.content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      if (dispatch(JSON.parse(trimmed) as Parsed) === "delivered") return;
    } catch {
      continue;
    }
  }
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
