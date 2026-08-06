import { useQuery } from "@tanstack/react-query";

import {
  configGetOptions,
  conversationsByIdGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useCallSiteDefaultProfile } from "@/hooks/use-call-site-default-profile";

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
 * or the shipped default, in the daemon's own precedence order. Billing then
 * comes off that profile's `usesVellumCredits`, which the daemon derives from
 * the connection the profile dispatches through.
 *
 * Returns `true` whenever the answer isn't established — no profile resolved
 * yet, queries still loading, or an assistant old enough not to stamp the flag.
 * Unknown must read as "credits apply" so a genuine credit wall is never
 * hidden; the cost of that default is the status quo, and the flag only ever
 * turns a surface off.
 */
export function useChatUsesVellumCredits(
  assistantId: string | null,
  conversationId: string | undefined,
  pendingProfile?: string | null,
): boolean {
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: !!assistantId && !!conversationId,
  });

  const callSiteDefault = useCallSiteDefaultProfile(
    assistantId ?? "",
    "mainAgent",
    { enabled: !!assistantId },
  );

  const effective =
    convData?.conversation.inferenceProfile ??
    pendingProfile ??
    callSiteDefault.key;
  if (!effective) {
    return true;
  }
  return config?.llm?.profiles?.[effective]?.usesVellumCredits ?? true;
}
