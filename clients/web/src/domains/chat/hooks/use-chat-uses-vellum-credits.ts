import { useQuery } from "@tanstack/react-query";

import {
  configGetOptions,
  conversationsByIdGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useCallSiteDefaultProfile } from "@/hooks/use-call-site-default-profile";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { profileUsesVellumCredits } from "@/lib/billing/vellum-managed-route";

/**
 * Whether a turn in this chat is billed to the org's Vellum credit balance.
 *
 * A chat that dispatches through a bring-your-own connection — a provider API
 * key, or a ChatGPT subscription — spends no Vellum credits, so an exhausted
 * balance says nothing about whether the user can keep talking. The proactive
 * credit surfaces (the transcript's upsell card, the empty state's card, the
 * composer's low-balance and daily-limit banners) key off this so they stop
 * claiming a wall the chat will never hit.
 *
 * The profile that answers is the one the turn would run on: the
 * conversation's own override, else the composer's stashed draft profile (for
 * a conversation whose row hasn't loaded), else whatever the daemon says the
 * `mainAgent` call site resolves to — `llm.activeProfile`, the call-site pin,
 * or the shipped default, in the daemon's own precedence order. Only the
 * billed-route question is answered here; the precedence chain is never
 * re-derived client-side.
 *
 * Returns `true` whenever the answer isn't established — queries still
 * loading, no profile resolved, or a profile whose route its entry can't
 * answer for (see {@link profileUsesVellumCredits}). Unknown must read as
 * "credits apply" so a genuine credit wall is never hidden; the cost of that
 * default is the status quo, and this only ever turns a surface off.
 */
export function useChatUsesVellumCredits(
  assistantId: string | null,
  conversationId: string | undefined,
  pendingProfile?: string | null,
): boolean {
  // Platform-mode daemon requests need the `Vellum-Organization-Id` header,
  // which the interceptor reads from the org store — so every query here
  // waits for hydration rather than firing header-less on a cold start.
  const isOrgReady = useIsOrgReady();
  const enabled = !!assistantId && isOrgReady;

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: 30_000,
  });

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: enabled && !!conversationId,
  });

  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled,
    staleTime: 30_000,
  });

  const callSiteDefault = useCallSiteDefaultProfile(
    assistantId ?? "",
    "mainAgent",
    { enabled },
  );

  const effective =
    convData?.conversation.inferenceProfile ??
    pendingProfile ??
    callSiteDefault.key;
  const entry = effective ? config?.llm?.profiles?.[effective] : undefined;
  if (!entry) {
    return true;
  }
  return (
    profileUsesVellumCredits(entry, connectionsData?.connections ?? []) ?? true
  );
}
