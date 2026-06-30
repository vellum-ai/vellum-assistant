/**
 * Construction-time system-prompt resolution for a new conversation.
 *
 * Kept in its own low-dependency module so the warm-then-build sequencing can
 * be unit-tested without constructing a full `Conversation` (and its provider /
 * tool / agent-loop graph).
 */
import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";

/**
 * Resolve the system prompt to freeze onto a newly constructed conversation.
 *
 * An explicit `systemPromptOverride` is used verbatim. Otherwise the prompt is
 * the default `buildSystemPrompt()` build — but the gateway-owned guardian
 * binding is warmed first so that build's persona slot resolves the guardian's
 * `users/<slug>.md` instead of falling back to `users/default.md`.
 *
 * The binding is reachable only asynchronously; the sync persona resolver reads
 * the IO-free cache that `getGuardianDelivery` populates. The conversation's
 * system prompt is built once at construction and reused for every turn (the
 * agent loop never re-resolves it), so a cold cache at this point would pin the
 * wrong persona for the conversation's whole lifetime. Best-effort: an
 * unreachable gateway leaves the cache empty and the persona stays at the
 * default fallback.
 */
export async function resolveInitialSystemPrompt(
  storedOptions: ConversationCreateOptions | undefined,
): Promise<string> {
  if (storedOptions?.systemPromptOverride) {
    return storedOptions.systemPromptOverride;
  }
  await getGuardianDelivery({ channelTypes: ["vellum"] });
  return buildSystemPrompt();
}
