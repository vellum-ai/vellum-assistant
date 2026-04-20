/**
 * meet-join skill — tool registration entry point.
 *
 * Imports every meet_* tool exported by this skill and hands them to the
 * assistant's tool registry when the `meet` feature flag is on.
 * `initializeTools()` in `assistant/src/tools/registry.ts` reads the
 * external tool list at daemon startup so the tools become visible to the
 * LLM for the lifetime of the process.
 *
 * This module is intentionally a pure side-effect module: `import`ing it
 * is all the bootstrap needs to do. It has no default export and its
 * name is never referenced by downstream code.
 *
 * ## Feature-flag semantics
 *
 * Registration is gated by the `meet` feature flag at module-load time,
 * mirroring the CES-tools pattern in `registry.ts` — tools only
 * enter the registry (and therefore only occupy LLM tool-list tokens)
 * when the flag is on. Toggling the flag requires a daemon restart to
 * take effect, which is acceptable because the same is true for every
 * other feature-flag-gated capability on the daemon.
 *
 * Each tool also performs a defensive in-`execute()` flag check so
 * stale tool definitions cached by a long-running agent turn can't
 * silently fall through to the session manager.
 */

import { isAssistantFeatureFlagEnabled } from "../../assistant/src/config/assistant-feature-flags.js";
import { getConfig } from "../../assistant/src/config/loader.js";
import { registerExternalTools } from "../../assistant/src/tools/registry.js";
import {
  meetDisableAvatarTool,
  meetEnableAvatarTool,
} from "./tools/meet-avatar-tool.js";
import { MEET_FLAG_KEY, meetJoinTool } from "./tools/meet-join-tool.js";
import { meetLeaveTool } from "./tools/meet-leave-tool.js";
import { meetSendChatTool } from "./tools/meet-send-chat-tool.js";
import { meetCancelSpeakTool, meetSpeakTool } from "./tools/meet-speak-tool.js";

function tryRegisterMeetTools(): void {
  try {
    const config = getConfig();
    if (!isAssistantFeatureFlagEnabled(MEET_FLAG_KEY, config)) {
      return;
    }
  } catch {
    // Config not yet loaded (e.g. during certain test setups) — treat as
    // flag off so tool definitions don't leak into test scopes that
    // haven't opted in.
    return;
  }

  registerExternalTools([
    meetJoinTool,
    meetLeaveTool,
    meetSendChatTool,
    meetSpeakTool,
    meetCancelSpeakTool,
    meetEnableAvatarTool,
    meetDisableAvatarTool,
  ]);
}

tryRegisterMeetTools();
