import { describe, expect, test } from 'bun:test';
import { resolveOnboardingRuntimeContext } from '../onboarding/onboarding-orchestrator.js';

describe('onboarding orchestrator', () => {
  test('activates onboarding runtime guidance for desktop onboarding sessions', () => {
    const resolved = resolveOnboardingRuntimeContext({
      channelId: 'desktop',
      hints: ['onboarding-active', 'onboarding-phase:post_hatch', 'assistant-name:Velly'],
      uxBrief: 'Onboarding session after hatch.',
      playbookContent: [
        '# Desktop',
        '- [ ] Start talking to your assistant',
        '- [ ] Capture user profile basics (name, preferred reference, goals, locale) in USER.md',
      ].join('\n'),
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.phase).toBe('post_hatch');
    expect(resolved?.prompt).toContain('Post-hatch ordered sequence');
    expect(resolved?.prompt).toContain('Capture onboarding profile details in USER.md directly');
    expect(resolved?.prompt).toContain('Do not proactively request microphone or computer-control permissions');
    expect(resolved?.prompt).toContain('Make it mine');
  });

  test('does not activate onboarding runtime guidance for unrelated sessions', () => {
    const resolved = resolveOnboardingRuntimeContext({
      channelId: 'desktop',
      hints: ['dashboard-capable'],
      uxBrief: 'General chat session.',
      playbookContent: '# General\n- [ ] Explore random features',
    });

    expect(resolved).toBeNull();
  });

  test('emits desktop handoff guidance for non-desktop channels', () => {
    const resolved = resolveOnboardingRuntimeContext({
      channelId: 'telegram',
      hints: ['onboarding-active'],
      uxBrief: 'Onboarding continuation for messaging channel.',
      playbookContent: [
        '# Telegram',
        '- [ ] Start talking to your assistant',
        '- [ ] Capture user profile basics (name, preferred reference, goals, locale) in USER.md',
      ].join('\n'),
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.prompt).toContain('Defer dashboard-only Home Base tasks');
    expect(resolved?.prompt).toContain('Enable voice mode');
  });
});
