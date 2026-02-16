export interface PostHatchSequenceStep {
  id: string;
  title: string;
  guidance: string;
}

const SEQUENCE: PostHatchSequenceStep[] = [
  {
    id: 'talk_first',
    title: 'Start talking to your assistant',
    guidance: 'Open with a short natural greeting and begin the first conversation immediately.',
  },
  {
    id: 'identity_and_personality',
    title: 'Assign assistant identity and personality',
    guidance: 'Lock in how the assistant should behave before discussing deeper setup flows.',
  },
  {
    id: 'capture_user_profile',
    title: 'Tell the assistant about the user',
    guidance:
      'Capture preferred name/reference, help goals, and locale; update USER.md directly via file_edit.',
  },
  {
    id: 'home_base_generation',
    title: 'Generate or open Home Base app',
    guidance:
      'After identity/profile basics are captured, generate/open Home Base and continue onboarding there.',
  },
];

export function getPostHatchSequence(): PostHatchSequenceStep[] {
  return SEQUENCE;
}
