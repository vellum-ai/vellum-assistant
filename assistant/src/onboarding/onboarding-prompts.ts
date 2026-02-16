import type { OnboardingModeState } from './onboarding-mode.js';
import { buildHomeBaseHandoffGuidance } from './app-bootstrap-handoff.js';
import { getPostHatchSequence } from './post-hatch-sequence.js';

function renderPostHatchSequenceLines(): string[] {
  const sequence = getPostHatchSequence();
  const lines = ['Post-hatch ordered sequence (do not reorder):'];
  for (const step of sequence) {
    lines.push(`- ${step.title}: ${step.guidance}`);
  }
  return lines;
}

function renderPhaseLine(phase: OnboardingModeState['phase']): string {
  if (phase === 'identity_and_profile') {
    return 'Current onboarding phase focus: identity + user profile capture.';
  }
  if (phase === 'home_base_handoff') {
    return 'Current onboarding phase focus: Home Base generation + handoff.';
  }
  return 'Current onboarding phase focus: post-hatch first conversation.';
}

export function buildOnboardingRuntimePrompt(
  mode: OnboardingModeState,
  homeBaseAppId?: string,
): string {
  const lines: string[] = [
    'You are in onboarding mode for this session.',
    renderPhaseLine(mode.phase),
    'Capture onboarding profile details in USER.md directly using normal file_edit flows.',
    'Do not create or rely on a separate locale/profile memory subsystem.',
    'Do not proactively request microphone or computer-control permissions during hatch + first conversation.',
    'Permission setup should stay user-initiated during onboarding: explicit user ask or optional setup prompts from Home Base.',
  ];

  if (mode.assistantName) {
    lines.push(`Assistant identity hint from client: ${mode.assistantName}.`);
  }

  if (homeBaseAppId) {
    lines.push(`Prebuilt Home Base app id: ${homeBaseAppId}. Reuse this app_id for Home Base flows.`);
  }

  lines.push(...renderPostHatchSequenceLines());
  lines.push(...buildHomeBaseHandoffGuidance(mode.channelId));

  return lines.join('\n');
}
