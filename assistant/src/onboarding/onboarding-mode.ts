export type OnboardingPhase =
  | 'post_hatch'
  | 'identity_and_profile'
  | 'home_base_handoff';

export type OnboardingSource = 'transport_hints' | 'transport_ux_brief' | 'playbook';

export interface OnboardingModeState {
  channelId: string;
  phase: OnboardingPhase;
  source: OnboardingSource;
  assistantName?: string;
  hints: string[];
}

const ONBOARDING_HINTS = new Set([
  'onboarding',
  'onboarding-active',
  'onboarding_active',
]);

const PHASE_HINT_PREFIX = 'onboarding-phase:';
const NAME_HINT_PREFIX = 'assistant-name:';

function normalizeHints(hints?: string[]): string[] {
  if (!hints) return [];
  return hints
    .map((hint) => hint.trim().toLowerCase())
    .filter((hint) => hint.length > 0);
}

function resolvePhase(hints: string[]): OnboardingPhase {
  const phaseHint = hints.find((hint) => hint.startsWith(PHASE_HINT_PREFIX));
  if (!phaseHint) return 'post_hatch';

  const raw = phaseHint.slice(PHASE_HINT_PREFIX.length);
  if (raw === 'identity_and_profile') return 'identity_and_profile';
  if (raw === 'home_base_handoff') return 'home_base_handoff';
  if (raw === 'continuation') return 'home_base_handoff';
  return 'post_hatch';
}

function resolveAssistantName(hints: string[]): string | undefined {
  const nameHint = hints.find((hint) => hint.startsWith(NAME_HINT_PREFIX));
  if (!nameHint) return undefined;
  const value = nameHint.slice(NAME_HINT_PREFIX.length).trim();
  return value.length > 0 ? value : undefined;
}

function playbookLooksLikeOnboarding(playbookContent: string): boolean {
  const content = playbookContent.toLowerCase();
  return (
    content.includes('start talking to your assistant')
    && content.includes('capture user profile basics')
  );
}

function uxBriefLooksLikeOnboarding(uxBrief?: string): boolean {
  if (!uxBrief) return false;
  return uxBrief.toLowerCase().includes('onboarding');
}

export function resolveOnboardingModeState(input: {
  channelId: string;
  hints?: string[];
  uxBrief?: string;
  playbookContent: string;
}): OnboardingModeState | null {
  const hints = normalizeHints(input.hints);
  const hintActivated = hints.some((hint) => ONBOARDING_HINTS.has(hint));
  const uxActivated = uxBriefLooksLikeOnboarding(input.uxBrief);
  const playbookActivated = playbookLooksLikeOnboarding(input.playbookContent);

  if (!hintActivated && !uxActivated && !playbookActivated) {
    return null;
  }

  const source: OnboardingSource = hintActivated
    ? 'transport_hints'
    : uxActivated
      ? 'transport_ux_brief'
      : 'playbook';

  return {
    channelId: input.channelId,
    phase: resolvePhase(hints),
    source,
    assistantName: resolveAssistantName(hints),
    hints,
  };
}
