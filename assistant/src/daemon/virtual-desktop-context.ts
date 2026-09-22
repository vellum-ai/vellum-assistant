import type { ToolContext } from "../tools/types.js";
import type { Conversation } from "./conversation.js";
import { resolveTurnClientOs } from "./conversation-client-surface.js";
import { FALLBACK_TURN_TRUST, resolveTrustClass } from "./trust-context.js";
import { turnActorPrincipalId } from "./turn-actor.js";

export function virtualDesktopContext(
  ctx: Conversation,
  signal?: AbortSignal,
): ToolContext {
  return {
    workingDir: ctx.workingDir,
    conversationId: ctx.conversationId,
    trustClass: resolveTrustClass(
      ctx.getTurnOrRestingTrust?.() ?? FALLBACK_TURN_TRUST,
    ),
    ...resolveTurnClientOs(ctx),
    sourceActorPrincipalId: turnActorPrincipalId(ctx),
    signal,
  };
}
