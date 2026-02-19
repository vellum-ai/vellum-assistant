import { describe, test, expect } from 'bun:test';
import type { Message } from '../providers/types.js';
import {
  applyRuntimeInjections,
  injectChannelCapabilityContext,
  injectTemporalContext,
  resolveChannelCapabilities,
  stripChannelCapabilityContext,
  stripTemporalContext,
} from '../daemon/session-runtime-assembly.js';
import type { ChannelCapabilities } from '../daemon/session-runtime-assembly.js';
import { buildChannelAwarenessSection } from '../config/system-prompt.js';

// ---------------------------------------------------------------------------
// resolveChannelCapabilities
// ---------------------------------------------------------------------------

describe('resolveChannelCapabilities', () => {
  test('defaults to dashboard when no source channel is provided', () => {
    const caps = resolveChannelCapabilities();
    expect(caps.channel).toBe('dashboard');
    expect(caps.dashboardCapable).toBe(true);
    expect(caps.supportsDynamicUi).toBe(true);
    expect(caps.supportsVoiceInput).toBe(true);
  });

  test('defaults to dashboard for null source channel', () => {
    const caps = resolveChannelCapabilities(null);
    expect(caps.channel).toBe('dashboard');
    expect(caps.dashboardCapable).toBe(true);
  });

  test('resolves "dashboard" as dashboard-capable', () => {
    const caps = resolveChannelCapabilities('dashboard');
    expect(caps.channel).toBe('dashboard');
    expect(caps.dashboardCapable).toBe(true);
    expect(caps.supportsDynamicUi).toBe(true);
    expect(caps.supportsVoiceInput).toBe(true);
  });

  test('resolves "telegram" as non-dashboard-capable', () => {
    const caps = resolveChannelCapabilities('telegram');
    expect(caps.channel).toBe('telegram');
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test('resolves "http-api" as non-dashboard-capable', () => {
    const caps = resolveChannelCapabilities('http-api');
    expect(caps.channel).toBe('http-api');
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// injectChannelCapabilityContext
// ---------------------------------------------------------------------------

describe('injectChannelCapabilityContext', () => {
  const baseUserMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Hello' }],
  };

  test('injects channel capabilities block for dashboard channel', () => {
    const caps: ChannelCapabilities = {
      channel: 'dashboard',
      dashboardCapable: true,
      supportsDynamicUi: true,
      supportsVoiceInput: true,
    };

    const result = injectChannelCapabilityContext(baseUserMessage, caps);

    // Should prepend a text block with channel_capabilities
    expect(result.content.length).toBe(2);
    const injected = result.content[0];
    expect(injected.type).toBe('text');
    expect((injected as { type: 'text'; text: string }).text).toContain('<channel_capabilities>');
    expect((injected as { type: 'text'; text: string }).text).toContain('dashboard_capable: true');
    expect((injected as { type: 'text'; text: string }).text).toContain('supports_dynamic_ui: true');
    expect((injected as { type: 'text'; text: string }).text).toContain('</channel_capabilities>');
    // Should NOT contain constraint rules for dashboard
    expect((injected as { type: 'text'; text: string }).text).not.toContain('CHANNEL CONSTRAINTS');
  });

  test('injects constraint rules for non-dashboard channel', () => {
    const caps: ChannelCapabilities = {
      channel: 'telegram',
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    };

    const result = injectChannelCapabilityContext(baseUserMessage, caps);

    const injected = result.content[0];
    const text = (injected as { type: 'text'; text: string }).text;
    expect(text).toContain('CHANNEL CONSTRAINTS');
    expect(text).toContain('Do NOT reference the dashboard UI');
    expect(text).toContain('Do NOT use ui_show');
    expect(text).toContain('Do NOT ask the user to use voice');
    expect(text).toContain('dashboard_capable: false');
  });

  test('preserves original message content after injection', () => {
    const caps: ChannelCapabilities = {
      channel: 'telegram',
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    };

    const result = injectChannelCapabilityContext(baseUserMessage, caps);

    // Original content should be at the end
    const lastBlock = result.content[result.content.length - 1];
    expect((lastBlock as { type: 'text'; text: string }).text).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// stripChannelCapabilityContext
// ---------------------------------------------------------------------------

describe('stripChannelCapabilityContext', () => {
  test('strips channel_capabilities blocks from user messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<channel_capabilities>\nchannel: telegram\n</channel_capabilities>' },
          { type: 'text', text: 'Hello' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
      },
    ];

    const result = stripChannelCapabilityContext(messages);

    expect(result.length).toBe(2);
    expect(result[0].content.length).toBe(1);
    expect((result[0].content[0] as { type: 'text'; text: string }).text).toBe('Hello');
    // Assistant message untouched
    expect(result[1].content.length).toBe(1);
  });

  test('removes user messages that only contain channel_capabilities', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<channel_capabilities>\nchannel: telegram\n</channel_capabilities>' },
        ],
      },
    ];

    const result = stripChannelCapabilityContext(messages);
    expect(result.length).toBe(0);
  });

  test('leaves messages without channel_capabilities untouched', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Normal message' }],
      },
    ];

    const result = stripChannelCapabilityContext(messages);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[0]); // Same reference — untouched
  });
});

// ---------------------------------------------------------------------------
// applyRuntimeInjections with channelCapabilities
// ---------------------------------------------------------------------------

describe('applyRuntimeInjections with channelCapabilities', () => {
  const baseMessages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'What can you do?' }],
    },
  ];

  test('injects channel capabilities when provided', () => {
    const caps: ChannelCapabilities = {
      channel: 'telegram',
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    };

    const result = applyRuntimeInjections(baseMessages, {
      channelCapabilities: caps,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(2);
    const injected = result[0].content[0];
    expect((injected as { type: 'text'; text: string }).text).toContain('<channel_capabilities>');
  });

  test('does not inject when channelCapabilities is null', () => {
    const result = applyRuntimeInjections(baseMessages, {
      channelCapabilities: null,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });

  test('does not inject when channelCapabilities is omitted', () => {
    const result = applyRuntimeInjections(baseMessages, {});

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });

  test('combines with other injections', () => {
    const caps: ChannelCapabilities = {
      channel: 'telegram',
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    };

    const result = applyRuntimeInjections(baseMessages, {
      softConflictInstruction: 'What is your name?',
      channelCapabilities: caps,
    });

    expect(result.length).toBe(1);
    // softConflictInstruction appends, channelCapabilities prepends
    expect(result[0].content.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildChannelAwarenessSection
// ---------------------------------------------------------------------------

describe('buildChannelAwarenessSection', () => {
  test('includes channel awareness heading', () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain('## Channel Awareness & Trust Gating');
  });

  test('includes channel-specific rules', () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain('dashboard_capable');
    expect(section).toContain('supports_dynamic_ui');
    expect(section).toContain('supports_voice_input');
  });

  test('includes trust gating rules for permission asks', () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain('firstConversationComplete');
    expect(section).toContain('Permission ask trust gating');
    expect(section).toContain('Do NOT proactively ask for elevated permissions');
  });

  test('gates microphone permissions on voice capability', () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain('Do not ask for microphone permissions');
  });

  test('gates computer-control on dashboard channel', () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain('computer-control permissions on non-dashboard');
  });
});

// ---------------------------------------------------------------------------
// Trust-gating behavior: channel constraints for permission asks
// ---------------------------------------------------------------------------

describe('trust-gating via channel capabilities', () => {
  test('dashboard channel does not add constraint rules', () => {
    const caps = resolveChannelCapabilities('dashboard');
    const message: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'Enable my microphone' }],
    };

    const result = injectChannelCapabilityContext(message, caps);
    const injected = (result.content[0] as { type: 'text'; text: string }).text;

    expect(injected).not.toContain('CHANNEL CONSTRAINTS');
    expect(injected).toContain('dashboard_capable: true');
  });

  test('non-dashboard channel adds constraint rules preventing UI references', () => {
    const caps = resolveChannelCapabilities('slack');
    const message: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'Show me a chart' }],
    };

    const result = injectChannelCapabilityContext(message, caps);
    const injected = (result.content[0] as { type: 'text'; text: string }).text;

    expect(injected).toContain('CHANNEL CONSTRAINTS');
    expect(injected).toContain('Do NOT reference the dashboard UI');
    expect(injected).toContain('Do NOT use ui_show, ui_update, or app_create');
    expect(injected).toContain('Present information as well-formatted text');
    expect(injected).toContain('desktop app');
  });
});

// ---------------------------------------------------------------------------
// injectTemporalContext
// ---------------------------------------------------------------------------

describe('injectTemporalContext', () => {
  const baseUserMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Plan a trip for next weekend' }],
  };

  const sampleContext = '<temporal_context>\nToday: 2026-02-18 (Wednesday)\nTimezone: UTC\n</temporal_context>';

  test('prepends temporal context block to user message', () => {
    const result = injectTemporalContext(baseUserMessage, sampleContext);
    expect(result.content.length).toBe(2);
    const injected = result.content[0];
    expect(injected.type).toBe('text');
    expect((injected as { type: 'text'; text: string }).text).toContain('<temporal_context>');
    expect((injected as { type: 'text'; text: string }).text).toContain('2026-02-18');
  });

  test('preserves original message content', () => {
    const result = injectTemporalContext(baseUserMessage, sampleContext);
    const lastBlock = result.content[result.content.length - 1];
    expect((lastBlock as { type: 'text'; text: string }).text).toBe('Plan a trip for next weekend');
  });
});

// ---------------------------------------------------------------------------
// stripTemporalContext
// ---------------------------------------------------------------------------

describe('stripTemporalContext', () => {
  test('strips temporal_context blocks from user messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<temporal_context>\nToday: 2026-02-18\n</temporal_context>' },
          { type: 'text', text: 'Hello' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
      },
    ];

    const result = stripTemporalContext(messages);

    expect(result.length).toBe(2);
    expect(result[0].content.length).toBe(1);
    expect((result[0].content[0] as { type: 'text'; text: string }).text).toBe('Hello');
    // Assistant message untouched
    expect(result[1].content.length).toBe(1);
  });

  test('removes user messages that only contain temporal_context', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<temporal_context>\nToday: 2026-02-18\n</temporal_context>' },
        ],
      },
    ];

    const result = stripTemporalContext(messages);
    expect(result.length).toBe(0);
  });

  test('does not touch unrelated blocks', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<channel_capabilities>\nchannel: dashboard\n</channel_capabilities>' },
          { type: 'text', text: 'Hello' },
        ],
      },
    ];

    const result = stripTemporalContext(messages);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[0]); // Same reference — untouched
  });

  test('leaves messages without temporal_context untouched', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Normal message' }],
      },
    ];

    const result = stripTemporalContext(messages);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[0]);
  });

  test('preserves user-authored text that starts with <temporal_context> but not the injected prefix', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<temporal_context>some user XML content</temporal_context>' },
          { type: 'text', text: 'Hello' },
        ],
      },
    ];

    const result = stripTemporalContext(messages);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[0]); // Same reference — untouched
  });
});

// ---------------------------------------------------------------------------
// applyRuntimeInjections with temporalContext
// ---------------------------------------------------------------------------

describe('applyRuntimeInjections with temporalContext', () => {
  const baseMessages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'When is next weekend?' }],
    },
  ];

  const sampleContext = '<temporal_context>\nToday: 2026-02-18 (Wednesday)\n</temporal_context>';

  test('injects temporal context when provided', () => {
    const result = applyRuntimeInjections(baseMessages, {
      temporalContext: sampleContext,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(2);
    const injected = result[0].content[0];
    expect((injected as { type: 'text'; text: string }).text).toContain('<temporal_context>');
  });

  test('does not inject when temporalContext is null', () => {
    const result = applyRuntimeInjections(baseMessages, {
      temporalContext: null,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });

  test('does not inject when temporalContext is omitted', () => {
    const result = applyRuntimeInjections(baseMessages, {});

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });
});
