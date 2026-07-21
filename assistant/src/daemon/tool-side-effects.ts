/**
 * Registry of per-tool post-execution side effects.
 *
 * Each entry maps one or more tool names to a handler that runs after
 * successful execution. This keeps the main tool executor callback
 * focused on orchestration — adding a new side effect is a single
 * registry entry instead of another if/else branch.
 */

import { isAbsolute, resolve, sep } from "node:path";

import { addAppConversationId, getApp } from "../apps/app-store.js";
import { findActiveSession } from "../channels/gateway-verification-sessions.js";
import { getConfig } from "../config/loader.js";
import { generateAppIcon } from "../media/app-icon-generator.js";
import { invalidateEdgeIndex } from "../plugins/defaults/memory/v3/substrate/edge-index.js";
import { invalidatePageIndex } from "../plugins/defaults/memory/v3/substrate/page-index.js";
import { getConceptsDir } from "../plugins/defaults/memory/v3/substrate/page-store.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { publishAppsChanged } from "../runtime/sync/resource-sync-events.js";
import { deliverVerificationSlack } from "../runtime/verification-outbound-actions.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { ensureAppSourceWatcher } from "./app-source-watcher.js";
import { refreshSurfacesForApp } from "./conversation-surfaces.js";
import { isDoordashCommand, updateDoordashProgress } from "./doordash-steps.js";
import type { ServerMessage } from "./message-protocol.js";
import type { ToolSetupContext } from "./tool-setup-types.js";

const log = getLogger("tool-side-effects");

// ── Types ────────────────────────────────────────────────────────────

export interface SideEffectContext {
  ctx: ToolSetupContext;
}

export type PostExecutionHook = (
  name: string,
  input: Record<string, unknown>,
  result: ToolExecutionResult,
  sideEffectCtx: SideEffectContext,
) => void | Promise<void>;

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
  opts?: { fileChange?: boolean; status?: string },
): void {
  refreshSurfacesForApp(ctx, appId, opts);
  broadcastAppFilesChanged(appId);
  void updatePublishedAppDeployment(appId);
}

function broadcastAppFilesChanged(appId: string): void {
  broadcastMessage({ type: "app_files_changed", appId });
  publishAppsChanged();
}

/**
 * Resolve the app id a post-execution hook should act on.
 *
 * `app_id` is optional for the app-builder fallback tools (`app_update`,
 * `app_refresh`, `app_generate_icon`): when the model omits it, the skill
 * script resolves the conversation's active app and the executor operates on
 * that id. Prefer the explicit tool input; otherwise use the id the executor
 * reports through the typed `resolvedAppId` side channel, so an omitted-id call
 * still refreshes surfaces, rebroadcasts, and re-deploys instead of silently
 * no-op'ing. The hook must not infer the id by re-parsing the LLM-facing
 * `result.content` (see assistant/AGENTS.md § Post-execution hooks).
 */
function resolveHookAppId(
  input: Record<string, unknown>,
  result: ToolExecutionResult,
): string | undefined {
  const explicit = input.app_id;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  return result.resolvedAppId;
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
registerHook("app_create", (_name, _input, result, { ctx }) => {
  const appId = result.resolvedAppId;
  if (!appId) {
    return;
  }
  try {
    addAppConversationId(appId, ctx.conversationId);
  } catch (err) {
    log.warn({ err, appId }, "Failed to track conversation ID on app_create");
  }

  ensureAppSourceWatcher();

  notifyAppChanged(ctx, appId);

  // Seed background icon generation from the created app's canonical record
  // (its name/description) rather than the LLM-facing result payload.
  const app = getApp(appId);
  if (app?.name) {
    void generateAppIcon(appId, app.name, app.description)
      .then(() => {
        broadcastAppFilesChanged(appId);
      })
      .catch((err) => {
        log.warn({ err, appId }, "Background icon generation failed");
      });
  }
});

registerHook("app_generate_icon", (_name, input, result) => {
  const appId = resolveHookAppId(input, result);
  if (appId) {
    broadcastAppFilesChanged(appId);
  }
});

registerHook("app_delete", (_name, input) => {
  const appId = input.app_id as string | undefined;
  if (appId) {
    broadcastAppFilesChanged(appId);
  }
});

// app_refresh and app_update mutate an app's source but emit no events of their
// own, so without a hook an updated app leaves open surfaces rendering the stale
// dist and never re-deploys or invalidates the Library. The executor owns the
// compile; notifyAppChanged only refreshes surfaces and broadcasts.
function registerAppSurfaceRefreshHook(toolName: string): void {
  registerHook(toolName, (name, input, result, { ctx }) => {
    const appId = resolveHookAppId(input, result);
    if (!appId) {
      return;
    }
    try {
      addAppConversationId(appId, ctx.conversationId);
    } catch (err) {
      log.warn({ err, appId }, `Failed to track conversation ID on ${name}`);
    }
    notifyAppChanged(ctx, appId, { fileChange: true });
  });
}
registerAppSurfaceRefreshHook("app_refresh");
registerAppSurfaceRefreshHook("app_update");

registerHook("voice_config_update", (_name, input) => {
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

  // `ttsVoiceId` is an ElevenLabs concept on the desktop client. When the
  // active provider is managed (vellum) or anything else, the voice lives only
  // in daemon config and hot-applies per turn — the tool skips the client
  // broadcast in that case, so this hook must too, else it would pollute the
  // client's ElevenLabs voice with, e.g., a Deepgram Aura model id.
  if (
    setting === "tts_voice_id" &&
    getConfig().services.tts.provider !== "elevenlabs"
  ) {
    return;
  }

  // Coerce the value to the correct type before broadcasting, matching
  // the validation logic in the tool's execute method.
  const raw = input.value;
  let coerced: string | boolean | number = raw as string;
  if (setting === "conversation_timeout") {
    coerced = typeof raw === "number" ? raw : Number(raw);
  } else if (setting === "tts_voice_id" && typeof raw === "string") {
    coerced = raw.trim();
  } else if (setting === "fish_audio_reference_id" && typeof raw === "string") {
    coerced = raw.trim();
  } else if (setting === "tts_provider" && typeof raw === "string") {
    coerced = raw.trim();
  }
  broadcastMessage({
    type: "client_settings_update",
    key,
    value: coerced,
  } as unknown as ServerMessage);
});

// Dispatch pending Slack DM delivery when a CLI verification command
// completes.  The CLI subprocess is sandboxed and cannot reach the
// gateway, so it includes a `_pendingSlackDm` field in its JSON output.
// This hook runs in the unsandboxed daemon process and delivers the DM.
registerHook("bash", async (_name, input, result) => {
  const command = (input.command ?? "") as string;
  if (!command.includes("channel-verification-sessions")) return;
  if (!result.content.includes("_pendingSlackDm")) return;

  type PendingDm = { userId: string; text: string; assistantId: string };
  type Parsed = { _pendingSlackDm?: PendingDm };

  // Returns "delivered" when DM was sent, "rejected" when _pendingSlackDm
  // was found but failed validation, or null when the field was absent.
  const dispatch = async (
    parsed: Parsed,
  ): Promise<"delivered" | "rejected" | null> => {
    if (parsed._pendingSlackDm) {
      const { userId, text, assistantId } = parsed._pendingSlackDm;

      // Validate that an active Slack verification session exists and
      // that the destination matches the userId in the parsed payload.
      // Fail closed: an unverifiable DM (gateway unreachable) is not sent.
      let session;
      try {
        session = await findActiveSession("slack");
      } catch (err) {
        log.warn(
          { err, userId, assistantId },
          "Bash hook: gateway session lookup failed — ignoring _pendingSlackDm",
        );
        return "rejected";
      }
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
  let singleObject: Parsed | undefined;
  try {
    singleObject = JSON.parse(result.content.trim()) as Parsed;
  } catch {
    // Not a single JSON object — fall back to line-by-line for
    // multi-object output (e.g. cancel + create chained with &&).
  }
  if (singleObject !== undefined) {
    if ((await dispatch(singleObject)) !== null) return;
  }
  for (const line of result.content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: Parsed;
    try {
      parsed = JSON.parse(trimmed) as Parsed;
    } catch {
      continue;
    }
    if ((await dispatch(parsed)) === "delivered") return;
  }
});

// Invalidate the in-memory v2 edge index and page index when the LLM writes
// or edits a file under `memory/concepts/`. The page-store invalidates on
// programmatic writes; this hook covers consolidation, where the LLM edits
// page frontmatter through the file tools rather than through `writePage`.
function invalidateEdgeIndexIfConceptPage(
  input: Record<string, unknown>,
): void {
  const rawPath = input.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return;
  const workspaceDir = getWorkspaceDir();
  const conceptsRoot = getConceptsDir(workspaceDir);
  const absPath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(workspaceDir, rawPath);
  const rootWithSep = conceptsRoot.endsWith(sep)
    ? conceptsRoot
    : conceptsRoot + sep;
  if (absPath.startsWith(rootWithSep)) {
    invalidateEdgeIndex(workspaceDir);
    invalidatePageIndex(workspaceDir);
  }
}
registerHook("file_write", (_name, input) =>
  invalidateEdgeIndexIfConceptPage(input),
);
registerHook("file_edit", (_name, input) =>
  invalidateEdgeIndexIfConceptPage(input),
);

// ── Runner ───────────────────────────────────────────────────────────

/**
 * Run all applicable post-execution side effects for a completed tool call.
 * Handles both registry-based hooks and the DoorDash step tracker (which
 * uses its own name-matching logic).
 *
 * Fire-and-forget for production callers; the returned promise lets tests
 * await async hooks. Hook failures are logged, never propagated.
 */
export async function runPostExecutionSideEffects(
  name: string,
  input: Record<string, unknown>,
  result: ToolExecutionResult,
  sideEffectCtx: SideEffectContext,
): Promise<void> {
  // Registry-based hooks only fire on success
  if (!result.isError) {
    const hook = postExecutionHooks.get(name);
    if (hook) {
      try {
        await hook(name, input, result, sideEffectCtx);
      } catch (err) {
        log.error({ err, toolName: name }, "Post-execution hook failed");
      }
    }
  }

  // DoorDash progress tracking fires on both success and failure
  try {
    if (isDoordashCommand(name, input)) {
      updateDoordashProgress(sideEffectCtx.ctx, input, result.isError);
    }
  } catch (err) {
    log.error({ err, toolName: name }, "DoorDash progress update failed");
  }
}
