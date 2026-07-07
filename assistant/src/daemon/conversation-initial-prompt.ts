/**
 * Construction-time system-prompt resolution for a new conversation.
 *
 * The dependency seams (`fetchDelivery`, `deps.warm`, `deps.build`) exist so the
 * warm-then-build sequencing can be unit-tested without mocking the
 * widely-imported guardian-delivery / system-prompt modules — global module
 * mocks of those leak across test files in the shared-process runner.
 */
import { getGuardianDeliveryFresh } from "../contacts/guardian-delivery-reader.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import type { TrustContext } from "./trust-context-types.js";

type GuardianDeliveryFetch = (input?: {
  channelTypes?: string[];
}) => Promise<unknown>;

/**
 * Warm both guardian-binding cache keys the desktop/native persona resolver
 * reads: the `"vellum"`-channel key for `peekGuardianForChannel("vellum")` and
 * the unfiltered key for its `peekAnyGuardian()` fallback. Warming only one
 * would still freeze `users/default.md` when the guardian lives on a non-vellum
 * channel (phone / Telegram).
 *
 * Uses the FRESH reader so warmup bypasses a stale/empty cached entry: a
 * gateway-side binding write (onboarding, rebind) does not invalidate the daemon
 * cache, so a non-fresh read could return an empty binding cached before the
 * guardian existed and freeze `users/default.md` until the TTL expires. The
 * fresh read repopulates the cache the sync `peek*` resolvers then read.
 * Best-effort — the reader swallows failures.
 */
export async function warmGuardianBindings(
  fetchDelivery: GuardianDeliveryFetch = getGuardianDeliveryFresh,
): Promise<void> {
  await Promise.all([
    fetchDelivery({ channelTypes: ["vellum"] }),
    fetchDelivery(),
  ]);
}

/**
 * Resolve the system prompt to freeze onto a newly constructed conversation.
 *
 * The conversation's prompt is built once here and reused for every turn (the
 * agent loop never re-resolves it), so the persona slot must resolve correctly
 * at construction.
 *
 * - An explicit `systemPromptOverride` (including an empty string) is used
 *   verbatim.
 * - A channel-routed conversation that already carries the requester's
 *   `trustContext` (e.g. Slack / Telegram inbound) builds with it, so the
 *   persona resolves the *requester's* `users/<slug>.md` (a DB contact lookup)
 *   rather than the guardian/default profile.
 * - Otherwise (no construction-time identity — the local vellum app sets trust
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
  if (trustContext === undefined) {
    await (deps.warm ?? warmGuardianBindings)();
  }
  const build =
    deps.build ??
    ((tc: TrustContext | undefined) => buildSystemPrompt({ trustContext: tc }));
  return build(trustContext);
}
