/**
 * Construction-time system-prompt resolution for a new conversation.
 *
 * The dependency seams (`deps.warm`, `deps.build`) exist so the warm-then-build
 * sequencing can be unit-tested without mocking the widely-imported
 * guardian-delivery / system-prompt modules — global module mocks of those leak
 * across test files in the shared-process runner.
 */
import { warmGuardianBindings } from "../contacts/guardian-delivery-reader.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import type { TrustContext } from "./trust-context-types.js";

/**
 * Resolve the system prompt to freeze onto a newly constructed conversation.
 *
 * The conversation's prompt is built once here and reused for every turn (the
 * agent loop never re-resolves it), so the persona slot must resolve correctly
 * at construction.
 *
 * - An explicit `systemPromptOverride` (including an empty string) is used
 *   verbatim.
 * - A channel-routed conversation carrying a non-guardian requester
 *   `trustContext` (e.g. Slack / Telegram inbound) builds with it directly:
 *   the requester's persona (`users/<slug>.md`) resolves via a DB contact
 *   lookup that needs no guardian binding.
 * - A guardian-class `trustContext` (background and scheduled turns, memory
 *   consolidation, managed desktop) warms the guardian binding first: its
 *   persona resolution reads the sync guardian-delivery cache, which is cold
 *   in worker processes (schedule worker, memory worker) and after TTL expiry
 *   in the daemon.
 * - Otherwise (no construction-time identity: the local vellum app sets trust
 *   after creation) the guardian binding is warmed first so the persona slot
 *   resolves the guardian's `users/<slug>.md` instead of `users/default.md` on
 *   a cold cache.
 */
export async function resolveInitialSystemPrompt(
  storedOptions: ConversationCreateOptions | undefined,
  deps: {
    warm?: () => Promise<void>;
    build?: (trustContext: TrustContext | undefined) => string;
  } = {},
): Promise<string> {
  if (storedOptions?.systemPromptOverride !== undefined) {
    return storedOptions.systemPromptOverride;
  }
  const trustContext = storedOptions?.trustContext;
  if (trustContext === undefined || trustContext.trustClass === "guardian") {
    await (deps.warm ?? warmGuardianBindings)();
  }
  const build =
    deps.build ??
    ((tc: TrustContext | undefined) => buildSystemPrompt({ trustContext: tc }));
  return build(trustContext);
}
