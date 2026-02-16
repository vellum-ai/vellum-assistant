import {
  resolveOnboardingModeState,
  type OnboardingModeState,
} from './onboarding-mode.js';
import { buildOnboardingRuntimePrompt } from './onboarding-prompts.js';
import { resolveHomeBaseAppId } from '../home-base/bootstrap.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('onboarding-orchestrator');

export interface OnboardingRuntimeContext {
  channelId: string;
  phase: OnboardingModeState['phase'];
  source: OnboardingModeState['source'];
  prompt: string;
  homeBaseAppId?: string;
}

export function resolveOnboardingRuntimeContext(input: {
  channelId: string;
  hints?: string[];
  uxBrief?: string;
  playbookContent: string;
}): OnboardingRuntimeContext | null {
  const mode = resolveOnboardingModeState(input);
  if (!mode) return null;

  let homeBaseAppId: string | undefined;
  if (mode.channelId === 'desktop') {
    try {
      homeBaseAppId = resolveHomeBaseAppId() ?? undefined;
    } catch (err) {
      log.warn({ err }, 'Failed to resolve Home Base app while building onboarding context');
    }
  }

  return {
    channelId: mode.channelId,
    phase: mode.phase,
    source: mode.source,
    prompt: buildOnboardingRuntimePrompt(mode, homeBaseAppId),
    homeBaseAppId,
  };
}
