import { findConversation } from "../../daemon/conversation-registry.js";
import type { ToolContext } from "../../tools/types.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";

export function browserCliConversationKey(sessionId: string): string {
  return `browser-cli:${sessionId}`;
}

export async function resolveBrowserContext(
  conversationId: string | undefined,
  sessionId: string,
  headers: Record<string, string>,
  abortSignal?: AbortSignal,
): Promise<ToolContext> {
  const conversation = conversationId
    ? findConversation(conversationId)
    : undefined;
  const actor = await resolveActorPrincipalIdForLocalGuardian(
    conversation?.getTurnActorPrincipalId() ??
      headers["x-vellum-actor-principal-id"]?.trim(),
  );
  const signals = [abortSignal, conversation?.abortController?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return {
    workingDir: process.cwd(),
    conversationId: conversation
      ? conversationId!
      : browserCliConversationKey(sessionId),
    trustClass: conversation?.trustContext?.trustClass ?? "unknown",
    transportInterface: conversation?.transportInterface,
    sourceActorPrincipalId: actor,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  };
}
