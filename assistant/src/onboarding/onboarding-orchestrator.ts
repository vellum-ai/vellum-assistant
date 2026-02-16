import {
  resolveOnboardingModeState,
  type OnboardingModeState,
} from './onboarding-mode.js';
import { buildOnboardingRuntimePrompt } from './onboarding-prompts.js';

export interface OnboardingRuntimeContext {
  channelId: string;
  phase: OnboardingModeState['phase'];
  source: OnboardingModeState['source'];
  prompt: string;
}

export function resolveOnboardingRuntimeContext(input: {
  channelId: string;
  hints?: string[];
  uxBrief?: string;
  playbookContent: string;
}): OnboardingRuntimeContext | null {
  const mode = resolveOnboardingModeState(input);
  if (!mode) return null;

  return {
    channelId: mode.channelId,
    phase: mode.phase,
    source: mode.source,
    prompt: buildOnboardingRuntimePrompt(mode),
  };
}
