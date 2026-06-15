/**
 * Cast onboarding flow — the replacement for the legacy `PreChatFlow` step
 * pages, served only to the `experiment-activation-flow-2026-06-03 =
 * personal-page` arm. Control / variant-a users continue to see `PreChatFlow`.
 *
 * Placeholder for now: routing is gated through `PreChatRoute`, and the real
 * screens (and the handoff into hatching) land in later PRs of the cast
 * onboarding plan. Keeping this in its own file means those PRs replace only
 * this component body without touching the routing seam.
 */
export function CastOnboardingFlow() {
  return null;
}
