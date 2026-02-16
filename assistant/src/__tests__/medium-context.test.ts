import { describe, expect, test } from 'bun:test';
import {
  applyRuntimeInjections,
  stripChannelOnboardingContext,
} from '../daemon/session-runtime-assembly.js';
import type { Message } from '../providers/types.js';

describe('medium context runtime injection', () => {
  test('injects channel onboarding playbook context with natural-language metadata', () => {
    const runMessages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Help me onboard quickly.' }],
      },
    ];

    const injected = applyRuntimeInjections(runMessages, {
      channelOnboarding: {
        channelId: 'telegram',
        playbookPath: '/tmp/telegram_onboarding.md',
        playbookName: 'telegram_onboarding.md',
        playbookContent: '# Telegram\n- [ ] Start talking to your assistant',
        uxBrief: 'Keep replies concise and chat-safe.',
        hints: ['Chat-first medium', 'Defer dashboard-only tasks'],
        guidanceBullets: ['Medium: chat-first messaging channel.'],
        reconciliation: {
          firstTimeFastPath: true,
          attempted: false,
          sourceChannels: [],
        },
      },
    });

    const userMessage = injected[injected.length - 1];
    const textBlocks = userMessage.content.filter((block) => block.type === 'text') as Array<{ type: 'text'; text: string }>;
    const first = textBlocks[0]?.text ?? '';

    expect(first).toContain('<channel_onboarding_playbook>');
    expect(first).toContain('channel_id: telegram');
    expect(first).toContain('transport_hints:');
    expect(first).toContain('Keep replies concise and chat-safe.');
    expect(first).not.toContain('capability_flags');
  });

  test('strips channel onboarding injection blocks from persisted history', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<channel_onboarding_playbook>\nfoo\n</channel_onboarding_playbook>' },
          { type: 'text', text: 'real user text' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    ];

    const stripped = stripChannelOnboardingContext(messages);
    const user = stripped[0];
    const text = user.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');

    expect(text).toContain('real user text');
    expect(text).not.toContain('<channel_onboarding_playbook>');
  });
});
