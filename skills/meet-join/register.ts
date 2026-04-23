/**
 * meet-join skill — tool and route registration entry point.
 *
 * Exported `register(host)` is called exactly once per daemon lifetime
 * by the assistant's external-skills bootstrap. It wires the skill's
 * `meet_*` tools and the meet-bot ingress HTTP route into the host's
 * registries so the LLM can invoke the tools and the bot can POST
 * events back to the daemon.
 *
 * ## Isolation
 *
 * This file and every module it imports takes a runtime-injected
 * `SkillHost` from `@vellumai/skill-host-contracts` for feature-flag
 * reads, logger access, event publication, and registry hooks. No file
 * under `skills/meet-join/` reaches into `assistant/src/...` directly;
 * the only cross-directory edge is the sanctioned named import of this
 * module from `assistant/src/daemon/external-skills-bootstrap.ts`.
 *
 * ## Feature-flag semantics
 *
 * Tool registration is gated by the `meet` feature flag. The check is
 * wrapped in the lazy provider closure passed to
 * `host.registries.registerTools(...)` — the daemon resolves the
 * closure inside `getExternalTools()`, which runs after
 * `mergeDefaultWorkspaceConfig()`, so the flag read sees the merged
 * workspace config rather than forcing an early `loadConfig()` against
 * unmerged defaults. Each tool also performs a defensive in-`execute()`
 * flag check so stale tool definitions cached by a long-running agent
 * turn can't silently fall through to the session manager.
 *
 * Route registration is unconditional — the handler authenticates
 * against the per-meeting bearer token resolver, which returns null
 * when no session is active. With the meet flag off, no sessions
 * exist, so every request gets a 401 from the handler itself rather
 * than silently falling through to the daemon's JWT middleware (which
 * would reject the bot's opaque bearer token as a malformed JWT).
 */

import type { SkillHost } from "@vellumai/skill-host-contracts";

import { createMeetSessionManager } from "./daemon/session-manager.js";
import {
  handleMeetInternalEvents,
  MEET_INTERNAL_EVENTS_PATH_RE,
} from "./routes/meet-internal.js";
import {
  createMeetDisableAvatarTool,
  createMeetEnableAvatarTool,
} from "./tools/meet-avatar-tool.js";
import {
  MEET_FLAG_KEY,
  createMeetJoinTool,
} from "./tools/meet-join-tool.js";
import { createMeetLeaveTool } from "./tools/meet-leave-tool.js";
import { createMeetSendChatTool } from "./tools/meet-send-chat-tool.js";
import {
  createMeetCancelSpeakTool,
  createMeetSpeakTool,
} from "./tools/meet-speak-tool.js";

export function register(host: SkillHost): void {
  // Construct the session manager eagerly so the tool modules that import
  // the module-level `MeetSessionManager` singleton resolve against a live
  // instance. Sub-module factories are resolved from the in-skill
  // registry inside the constructor — the session-manager module's
  // side-effect imports trigger the required `registerSubModule(...)`
  // registrations at import time.
  createMeetSessionManager(host);

  host.registries.registerSkillRoute({
    pattern: MEET_INTERNAL_EVENTS_PATH_RE,
    methods: ["POST"],
    handler: (req, match) => {
      // decodeURIComponent throws URIError on malformed percent-encoding
      // (e.g. a stray `%` without two hex digits). Without this guard the
      // error surfaces pre-auth and the daemon returns a 500 — reject with
      // a 400 instead so malformed bot URLs are observable as client errors.
      let meetingId: string;
      try {
        meetingId = decodeURIComponent(match[1]!);
      } catch {
        return Promise.resolve(
          Response.json(
            { error: "Invalid meeting id encoding" },
            { status: 400 },
          ),
        );
      }
      return handleMeetInternalEvents(host, req, meetingId);
    },
  });

  host.registries.registerTools(() => {
    try {
      if (!host.config.isFeatureFlagEnabled(MEET_FLAG_KEY)) {
        return [];
      }
    } catch {
      // Config not yet loaded (e.g. during certain test setups) — treat
      // as flag off so tool definitions don't leak into test scopes
      // that haven't opted in.
      return [];
    }

    return [
      createMeetJoinTool(host),
      createMeetLeaveTool(host),
      createMeetSendChatTool(host),
      createMeetSpeakTool(host),
      createMeetCancelSpeakTool(host),
      createMeetEnableAvatarTool(host),
      createMeetDisableAvatarTool(host),
    ];
  });
}
