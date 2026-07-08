/**
 * Trust context resolved during inbound message processing.
 *
 * Extracted from conversation-runtime-assembly.ts to break circular
 * imports (memory/conversation-crud → daemon/conversation-runtime-assembly).
 */
import type { ChannelConversationType } from "@vellumai/gateway-client";

import { isHttpAuthDisabled } from "../config/env.js";
import { shouldExposePersonalMemory } from "../plugins/defaults/memory/v2/static-context.js";
import type { TrustClass } from "../runtime/trust-class.js";
import type { TrustContext } from "./trust-context-types.js";

/**
 * Trust context used by internal background jobs (memory consolidation,
 * scheduled tasks) when invoking the agent loop without
 * an inbound actor identity. The assistant is the guardian over its own
 * internal state, so self-maintenance flows clear the side-effect
 * approval gate. Inbound message conversations derive trust per-actor from
 * the gateway-stamped verdict (`trustContextFromVerdict()`) and must not
 * use this constant.
 */
export const INTERNAL_GUARDIAN_TRUST_CONTEXT = {
  sourceChannel: "vellum",
  trustClass: "guardian",
} as const satisfies TrustContext;

/**
 * Synthetic fallback trust context used when a pipeline fires before the
 * per-turn trust snapshot has been captured (e.g. fresh conversations before
 * the trust resolver runs, heartbeat turns that never bind an actor, or
 * non-turn invocations like `Conversation.forceCompact`). We bias to
 * `unknown` rather than `guardian` so a missing snapshot cannot accidentally
 * grant elevated trust to a custom plugin reading `ctx.trust`.
 */
export const FALLBACK_TURN_TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "unknown",
};

/**
 * Resolve the effective trust class for an actor.
 *
 * Trust is a property of the actor, never of the deployment's auth posture.
 * The dev/local bypass therefore fills in `'guardian'` only when NO actor was
 * resolved: local/native turns reach the daemon without a channel-resolved
 * trustContext, and in an auth-disabled (local) deployment that unresolved
 * actor is the guardian. A *present* trustContext always reflects the real
 * actor — even under `DISABLE_HTTP_AUTH`, which is the standing config in
 * platform-managed deployments — so a resolved non-guardian channel actor is
 * never elevated to guardian.
 *
 * When no trust context is available and auth is enabled (e.g. a desktop-only
 * conversation that hasn't gone through channel trust resolution), defaults to
 * `'unknown'` to fail-closed.
 */
export function resolveTrustClass(
  trustContext: TrustContext | undefined,
): TrustClass {
  if (trustContext === undefined && isHttpAuthDisabled()) {
    return "guardian";
  }
  return trustContext?.trustClass ?? "unknown";
}

/**
 * Whether personal-memory content may be surfaced for the actor described by
 * `trustContext`: the gate admits guardian-class actors and internal/local
 * flows (including turns with no trust context), and blocks remote untrusted
 * actors — see {@link shouldExposePersonalMemory} for the rationale.
 *
 * This is THE personal-memory trust gate. Every surface that exposes private
 * user content — the v2 dynamic/static `<memory>` layers, PKB context, NOW.md,
 * memory-v3 cards/spotlight, and the `loadFromDb` rehydration of persisted
 * memory blocks — must call this one helper so the exposure rule cannot drift
 * between copies. It folds in {@link resolveTrustClass} so the dev-bypass
 * (HTTP auth disabled → guardian) applies uniformly at every call site.
 */
export function isPersonalMemoryAllowed(
  trustContext: TrustContext | undefined,
): boolean {
  return shouldExposePersonalMemory({
    sourceChannel: trustContext?.sourceChannel,
    isTrustedActor: resolveTrustClass(trustContext) === "guardian",
  });
}

/**
 * Map a channel-native chat type (Telegram `private`/`group`/`supergroup`,
 * Slack `im`/`mpim`/`channel`) onto the permission-matrix conversation-type
 * axis. Slack's gateway normalizer forwards every non-DM as `"channel"`
 * without distinguishing public from private, so `"channel"` maps to
 * undefined — a permissive public-channel cell must not silently govern
 * private channels. The channel-type tier starts matching for Slack non-DMs
 * once the gateway forwards the distinct type.
 */
export function mapChatTypeToConversationType(
  chatType?: string,
): ChannelConversationType | undefined {
  switch (chatType) {
    case "im": // Slack DM
    case "private": // Telegram DM
      return "dm";
    // "mpim" is Slack's multi-party DM. The gateway normalizer currently
    // collapses mpim into "channel", so this arm matches nothing from Slack
    // today; it pins the correct mapping for the raw Slack vocabulary.
    case "mpim":
    case "group": // Telegram group
    case "supergroup": // Telegram supergroup
      return "private";
    default:
      return undefined;
  }
}
