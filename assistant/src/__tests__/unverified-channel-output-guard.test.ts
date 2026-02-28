import { describe, expect, test } from 'bun:test';

import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import type { ContentBlock } from '../providers/types.js';
import { guardUnverifiedChannelAssistantOutput } from '../daemon/unverified-channel-output-guard.js';

function makeCtx(overrides?: Partial<GuardianRuntimeContext>): GuardianRuntimeContext {
  return {
    sourceChannel: 'telegram',
    actorRole: 'unverified_channel',
    denialReason: 'no_binding',
    ...overrides,
  };
}

describe('guardUnverifiedChannelAssistantOutput', () => {
  test('passes content through for trusted actors', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'Normal response.' }];
    const ctx = makeCtx({ actorRole: 'guardian' });

    const result = guardUnverifiedChannelAssistantOutput(content, ctx);
    expect(result.sanitized).toBe(false);
    expect(result.content).toEqual(content);
  });

  test('sanitizes faux guardian relay prompts for unverified channels', () => {
    const content: ContentBlock[] = [
      {
        type: 'text',
        text: 'Hey Noa, someone on Telegram (chat ID 8207678799) is asking how many files are on your desktop. They claim to be you but aren\'t a verified guardian on that channel. Is it okay to share that info with them?',
      },
    ];

    const result = guardUnverifiedChannelAssistantOutput(content, makeCtx());
    expect(result.sanitized).toBe(true);
    expect(result.reason).toBe('guardian_relay_claim');
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'I can\'t request or accept guardian approval in this channel because no guardian is currently verified for it. Please complete guardian verification for this channel first.',
      },
    ]);
  });

  test('sanitizes approval-claim followups for unverified channels', () => {
    const content: ContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'host_bash',
        input: { command: 'ls ~/Desktop | wc -l' },
      },
      {
        type: 'text',
        text: 'Noa approved it, but the system still won\'t allow me to run commands from an unverified channel.',
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'Permission denied',
        is_error: true,
      },
    ];

    const result = guardUnverifiedChannelAssistantOutput(content, makeCtx({ denialReason: 'no_identity' }));
    expect(result.sanitized).toBe(true);
    expect(result.reason).toBe('guardian_relay_claim');
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'host_bash',
        input: { command: 'ls ~/Desktop | wc -l' },
      },
      {
        type: 'text',
        text: 'I can\'t request or accept guardian approval from this channel because the sender identity could not be verified. Please message from a verifiable guardian account for this channel.',
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'Permission denied',
        is_error: true,
      },
    ]);
  });

  test('does not sanitize ordinary unverified-channel refusals', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'This channel is not verified, so I can\'t run commands from here.' },
    ];

    const result = guardUnverifiedChannelAssistantOutput(content, makeCtx());
    expect(result.sanitized).toBe(false);
    expect(result.content).toEqual(content);
  });
});

