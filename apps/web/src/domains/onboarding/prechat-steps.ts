/**
 * Declarative step model for the pre-chat onboarding flow.
 *
 * The flow is expressed as an ordered list of steps, each with the funnel
 * event it emits when the user advances past it. Which steps appear is a pure
 * function of the runtime's capabilities — local mode, feature-flag variant,
 * connected tools, and platform all "fall out" of the predicates here rather
 * than being special-cased across navigation handlers.
 *
 * Navigation operates on step **ids**, never numeric indices: `nextStep` and
 * `prevStep` resolve to the adjacent *enabled* step. Because back always lands
 * on the previous enabled step by construction, a back button can never reveal
 * a step the forward path gated off.
 */
import {
  ONBOARDING_FUNNEL_STEPS,
  type OnboardingFunnelStep,
} from "@/domains/onboarding/funnel-events";

export type PreChatStepId =
  | "name"
  | "taskTone"
  | "tools"
  | "priorAssistants"
  | "google"
  | "iosApp"
  | "nativeName"
  | "nativeVibe";

export interface PreChatStep {
  id: PreChatStepId;
  /**
   * Funnel event emitted when the user advances past this step. `null` for
   * steps outside the web funnel (the native iOS flow is not instrumented).
   */
  funnelStep: OnboardingFunnelStep | null;
}

/**
 * Capabilities that decide which web steps are reachable. Each maps to an
 * existing self-gate in the flow: feature-flag variant, the platform-backed
 * prior-assistants import, the Google OAuth step, whether a Google tool was
 * picked, and the iOS app nudge.
 */
export interface WebStepCapabilities {
  paredDown: boolean;
  canOfferPriorAssistants: boolean;
  canOfferGoogleStep: boolean;
  hasGoogleTool: boolean;
  showIOSAppStep: boolean;
}

/**
 * Resolve the ordered, enabled web steps. The pared-down funnel variant is the
 * same flow with most steps gated off, not a separate code path.
 */
export function resolveWebSteps(caps: WebStepCapabilities): PreChatStep[] {
  const { paredDown } = caps;
  const candidates: Array<PreChatStep & { enabled: boolean }> = [
    {
      id: "name",
      funnelStep: ONBOARDING_FUNNEL_STEPS.nameVibe,
      enabled: true,
    },
    {
      id: "taskTone",
      funnelStep: ONBOARDING_FUNNEL_STEPS.controlWorkType,
      enabled: !paredDown,
    },
    {
      id: "tools",
      funnelStep: ONBOARDING_FUNNEL_STEPS.controlTools,
      enabled: !paredDown,
    },
    {
      id: "priorAssistants",
      funnelStep: ONBOARDING_FUNNEL_STEPS.controlPriorAssistants,
      enabled: !paredDown && caps.canOfferPriorAssistants,
    },
    {
      id: "google",
      funnelStep: paredDown
        ? ONBOARDING_FUNNEL_STEPS.gmailConnect
        : ONBOARDING_FUNNEL_STEPS.controlGmailConnect,
      // The pared-down funnel has no tool-selection screen, so it offers
      // Google whenever the step is available; the control funnel only offers
      // it when the user actually picked a Google tool.
      enabled: caps.canOfferGoogleStep && (paredDown || caps.hasGoogleTool),
    },
    {
      id: "iosApp",
      funnelStep: ONBOARDING_FUNNEL_STEPS.controlGetApp,
      enabled: !paredDown && caps.showIOSAppStep,
    },
  ];
  return candidates
    .filter((step) => step.enabled)
    .map(({ enabled: _enabled, ...step }) => step);
}

/**
 * The native iOS flow: name → vibe, then a route to the privacy screen handled
 * by the caller. Not instrumented into the web funnel.
 */
export function resolveNativeSteps(): PreChatStep[] {
  return [
    { id: "nativeName", funnelStep: null },
    { id: "nativeVibe", funnelStep: null },
  ];
}

/** The next enabled step after `current`, or `null` if `current` is last. */
export function nextStep(
  steps: PreChatStep[],
  current: PreChatStepId,
): PreChatStepId | null {
  const index = steps.findIndex((step) => step.id === current);
  if (index < 0) return null;
  return steps[index + 1]?.id ?? null;
}

/** The previous enabled step before `current`, or `null` if `current` is first. */
export function prevStep(
  steps: PreChatStep[],
  current: PreChatStepId,
): PreChatStepId | null {
  const index = steps.findIndex((step) => step.id === current);
  if (index <= 0) return null;
  return steps[index - 1]?.id ?? null;
}
