/**
 * meet-join skill — tool and route registration entry point.
 *
 * Exported `register(host)` is called exactly once per daemon lifetime
 * by the assistant's external-skills bootstrap. It wires the skill's
 * `meet_*` tools and the meet-bot ingress HTTP route into the host's
 * registries so the LLM can invoke the tools and the bot can POST
 * events back to the daemon.
 *
 * ## Why a `register(host)` signature
 *
 * Historically this file side-effect-imported from `assistant/` for
 * feature-flag reads, logger access, and registry hooks. The
 * skill-isolation plan (`.private/plans/skill-isolation.md`) replaces
 * those imports with a runtime-injected `SkillHost` — a neutral
 * contract from `@vellumai/skill-host-contracts` that the assistant
 * implements via `DaemonSkillHost`. This file no longer reaches into
 * `assistant/` at all; the only cross-directory edge remaining is the
 * single sanctioned named import in
 * `assistant/src/daemon/external-skills-bootstrap.ts`.
 *
 * Later PRs (Waves 6+) migrate the individual tool and route modules
 * onto the same host contract. Until those land, the tool / route
 * implementations retain their current relative imports into
 * `assistant/`; only this entry point's signature changes in this PR.
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

import type { SkillHost, Tool } from "@vellumai/skill-host-contracts";

import {
  handleMeetInternalEvents,
  MEET_INTERNAL_EVENTS_PATH_RE,
} from "./routes/meet-internal.js";
import {
  meetDisableAvatarTool,
  meetEnableAvatarTool,
} from "./tools/meet-avatar-tool.js";
import { MEET_FLAG_KEY, meetJoinTool } from "./tools/meet-join-tool.js";
import { meetLeaveTool } from "./tools/meet-leave-tool.js";
import { meetSendChatTool } from "./tools/meet-send-chat-tool.js";
import { meetCancelSpeakTool, meetSpeakTool } from "./tools/meet-speak-tool.js";

export function register(host: SkillHost): void {
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

    // The concrete tool objects are still typed via `assistant/src/tools/types`
    // (migration lands in Wave 6 / PR 14). The host contract's `Tool` is a
    // structurally-leaner overlay of the same shape; the daemon-side
    // `DaemonSkillHost.registerTools` narrows back to the assistant flavor
    // at its boundary (see `daemon-skill-host.ts`). Cast here so the
    // contract-typed signature accepts the assistant-typed values until
    // each tool is individually migrated to import its types from the
    // neutral package.
    return [
      meetJoinTool,
      meetLeaveTool,
      meetSendChatTool,
      meetSpeakTool,
      meetCancelSpeakTool,
      meetEnableAvatarTool,
      meetDisableAvatarTool,
    ] as unknown as Tool[];
  });
}
