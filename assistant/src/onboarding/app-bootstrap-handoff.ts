export const HOME_BASE_REMAINING_TASKS = [
  'Make it mine',
  'Enable voice mode',
  'Enable computer control',
  'Try ambient mode',
] as const;

export function buildHomeBaseHandoffGuidance(channelId: string): string[] {
  if (channelId === 'desktop') {
    return [
      'After profile basics are captured, generate/open Home Base and seed remaining onboarding tasks.',
      `Seed task list: ${HOME_BASE_REMAINING_TASKS.join(', ')}.`,
      'Keep permission asks optional via dashboard tasks only, never proactive in hatch + first conversation.',
    ];
  }

  return [
    'Complete channel-safe onboarding steps in this channel.',
    'Defer dashboard-only Home Base tasks with a clear desktop handoff.',
    `When deferring, list remaining desktop tasks: ${HOME_BASE_REMAINING_TASKS.join(', ')}.`,
  ];
}
