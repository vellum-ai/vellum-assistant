/**
 * Construction-time system-prompt resolution for a new conversation.
 *
 * The dependency seams (`fetchDelivery`, `deps.warm`, `deps.build`) exist so the
 * warm-then-build sequencing can be unit-tested without mocking the
 * widely-imported guardian-delivery / system-prompt modules — global module
 * mocks of those leak across test files in the shared-process runner.
 */
import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";

type GuardianDeliveryFetch = (input?: {
  channelTypes?: string[];
}) => Promise<unknown>;

/**
 * Warm both guardian-binding cache keys the desktop/native persona resolver
 * reads: the `"vellum"`-channel key for `peekGuardianForChannel("vellum")` and
 * the unfiltered key for its `peekAnyGuardian()` fallback. Warming only one
 * would still freeze `users/default.md` when the guardian lives on a non-vellum
 * channel (phone / Telegram). Best-effort — the reader swallows failures.
 */
export async function warmGuardianBindings(
  fetchDelivery: GuardianDeliveryFetch = getGuardianDelivery,
): Promise<void> {
  await Promise.all([
    fetchDelivery({ channelTypes: ["vellum"] }),
    fetchDelivery(),
  ]);
}

/**
 * Resolve the system prompt to freeze onto a newly constructed conversation.
 *
 * An explicit `systemPromptOverride` (including an empty string) is used
 * verbatim. Otherwise the guardian binding is warmed first so the default
 * build's persona slot resolves the guardian's `users/<slug>.md` instead of
 * falling back to `users/default.md` on a cold cache — the conversation's
 * prompt is built once here and reused for every turn (the agent loop never
 * re-resolves it), so a cold cache would pin the wrong persona for the
 * conversation's whole lifetime.
 */
export async function resolveInitialSystemPrompt(
  storedOptions: ConversationCreateOptions | undefined,
  deps: { warm?: () => Promise<void>; build?: () => string } = {},
): Promise<string> {
  if (storedOptions?.systemPromptOverride !== undefined) {
    return storedOptions.systemPromptOverride;
  }
  await (deps.warm ?? warmGuardianBindings)();
  return (deps.build ?? buildSystemPrompt)();
}
