import { PreChatFlow } from "@/domains/onboarding/pages/pre-chat-flow";

/**
 * Routing seam for `onboarding/prechat`. Every arm now renders the standard
 * `PreChatFlow`; the `experiment-activation-flow-2026-06-03 = personal-page` arm
 * no longer swaps in a bespoke onboarding flow (the cast flow was removed). The
 * `personal-page` arm survives only as a sign-up-page variant
 * (`domains/account/**`), which is unaffected by this route.
 */
export function PreChatRoute() {
  return <PreChatFlow />;
}
