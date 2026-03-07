import { describe, expect, test } from "bun:test";

import { buildChannelAwarenessSection } from "../config/system-prompt.js";
import type {
  ChannelCapabilities,
  ChannelTurnContextParams,
  InboundActorContext,
} from "../daemon/session-runtime-assembly.js";
import {
  applyRuntimeInjections,
  buildChannelTurnContextBlock,
  injectChannelCapabilityContext,
  injectChannelTurnContext,
  injectInboundActorContext,
  injectTemporalContext,
  resolveChannelCapabilities,
  sanitizePttActivationKey,
  stripChannelCapabilityContext,
  stripChannelTurnContext,
  stripInboundActorContext,
  stripTemporalContext,
} from "../daemon/session-runtime-assembly.js";
import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// resolveChannelCapabilities
// ---------------------------------------------------------------------------

describe("resolveChannelCapabilities", () => {
  test("defaults to vellum when no source channel is provided", () => {
    const caps = resolveChannelCapabilities();
    expect(caps.channel).toBe("vellum");
    // Without a sourceInterface, desktop UI capabilities are false
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test("vellum channel with macos interface has full desktop capabilities", () => {
    const caps = resolveChannelCapabilities(undefined, "macos");
    expect(caps.channel).toBe("vellum");
    expect(caps.dashboardCapable).toBe(true);
    expect(caps.supportsDynamicUi).toBe(true);
    expect(caps.supportsVoiceInput).toBe(true);
  });

  test("vellum channel with vellum interface supports dynamic UI", () => {
    const caps = resolveChannelCapabilities("vellum", "vellum");
    expect(caps.channel).toBe("vellum");
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(true);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test("defaults to vellum for null source channel", () => {
    const caps = resolveChannelCapabilities(null);
    expect(caps.channel).toBe("vellum");
    expect(caps.dashboardCapable).toBe(false);
  });

  test('normalises "dashboard" to "vellum"', () => {
    const caps = resolveChannelCapabilities("dashboard");
    expect(caps.channel).toBe("vellum");
    // Without macos interface, capabilities are false
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test('normalises "http-api" to "vellum"', () => {
    const caps = resolveChannelCapabilities("http-api");
    expect(caps.channel).toBe("vellum");
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test('normalises "mac" to "vellum"', () => {
    const caps = resolveChannelCapabilities("mac");
    expect(caps.channel).toBe("vellum");
    expect(caps.dashboardCapable).toBe(false);
  });

  test('normalises "macos" to "vellum"', () => {
    const caps = resolveChannelCapabilities("macos");
    expect(caps.channel).toBe("vellum");
    expect(caps.dashboardCapable).toBe(false);
  });

  test('normalises "ios" to "vellum"', () => {
    const caps = resolveChannelCapabilities("ios");
    expect(caps.channel).toBe("vellum");
    expect(caps.dashboardCapable).toBe(false);
  });

  test('resolves "telegram" as non-dashboard-capable', () => {
    const caps = resolveChannelCapabilities("telegram");
    expect(caps.channel).toBe("telegram");
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test('resolves "whatsapp" as all-capabilities-false', () => {
    const caps = resolveChannelCapabilities("whatsapp");
    expect(caps.channel).toBe("whatsapp");
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test('resolves "slack" as all-capabilities-false', () => {
    const caps = resolveChannelCapabilities("slack");
    expect(caps.channel).toBe("slack");
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test('resolves "email" as all-capabilities-false', () => {
    const caps = resolveChannelCapabilities("email");
    expect(caps.channel).toBe("email");
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });

  test("unknown channel defaults to all-capabilities-false", () => {
    const caps = resolveChannelCapabilities("unknown-thing");
    expect(caps.channel).toBe("unknown-thing");
    expect(caps.dashboardCapable).toBe(false);
    expect(caps.supportsDynamicUi).toBe(false);
    expect(caps.supportsVoiceInput).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// injectChannelCapabilityContext
// ---------------------------------------------------------------------------

describe("injectChannelCapabilityContext", () => {
  const baseUserMessage: Message = {
    role: "user",
    content: [{ type: "text", text: "Hello" }],
  };

  test("injects channel capabilities block for dashboard channel", () => {
    const caps: ChannelCapabilities = {
      channel: "vellum",
      dashboardCapable: true,
      supportsDynamicUi: true,
      supportsVoiceInput: true,
    };

    const result = injectChannelCapabilityContext(baseUserMessage, caps);

    // Should prepend a text block with channel_capabilities
    expect(result.content.length).toBe(2);
    const injected = result.content[0];
    expect(injected.type).toBe("text");
    expect((injected as { type: "text"; text: string }).text).toContain(
      "<channel_capabilities>",
    );
    expect((injected as { type: "text"; text: string }).text).toContain(
      "dashboard_capable: true",
    );
    expect((injected as { type: "text"; text: string }).text).toContain(
      "supports_dynamic_ui: true",
    );
    expect((injected as { type: "text"; text: string }).text).toContain(
      "</channel_capabilities>",
    );
    // Should NOT contain constraint rules for dashboard
    expect((injected as { type: "text"; text: string }).text).not.toContain(
      "CHANNEL CONSTRAINTS",
    );
  });

  test("injects constraint rules for non-dashboard channel", () => {
    const caps: ChannelCapabilities = {
      channel: "telegram",
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    };

    const result = injectChannelCapabilityContext(baseUserMessage, caps);

    const injected = result.content[0];
    const text = (injected as { type: "text"; text: string }).text;
    expect(text).toContain("CHANNEL CONSTRAINTS");
    expect(text).toContain("Do NOT reference the dashboard UI");
    expect(text).toContain("Do NOT use ui_show");
    expect(text).toContain("Do NOT ask the user to use voice");
    expect(text).toContain("dashboard_capable: false");
  });

  test("preserves original message content after injection", () => {
    const caps: ChannelCapabilities = {
      channel: "telegram",
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    };

    const result = injectChannelCapabilityContext(baseUserMessage, caps);

    // Original content should be at the end
    const lastBlock = result.content[result.content.length - 1];
    expect((lastBlock as { type: "text"; text: string }).text).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// stripChannelCapabilityContext
// ---------------------------------------------------------------------------

describe("stripChannelCapabilityContext", () => {
  test("strips channel_capabilities blocks from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<channel_capabilities>\nchannel: telegram\n</channel_capabilities>",
          },
          { type: "text", text: "Hello" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ];

    const result = stripChannelCapabilityContext(messages);

    expect(result.length).toBe(2);
    expect(result[0].content.length).toBe(1);
    expect((result[0].content[0] as { type: "text"; text: string }).text).toBe(
      "Hello",
    );
    // Assistant message untouched
    expect(result[1].content.length).toBe(1);
  });

  test("removes user messages that only contain channel_capabilities", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<channel_capabilities>\nchannel: telegram\n</channel_capabilities>",
          },
        ],
      },
    ];

    const result = stripChannelCapabilityContext(messages);
    expect(result.length).toBe(0);
  });

  test("leaves messages without channel_capabilities untouched", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Normal message" }],
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

describe("applyRuntimeInjections with channelCapabilities", () => {
  const baseMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "What can you do?" }],
    },
  ];

  test("injects channel capabilities when provided", () => {
    const caps: ChannelCapabilities = {
      channel: "telegram",
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
    expect((injected as { type: "text"; text: string }).text).toContain(
      "<channel_capabilities>",
    );
  });

  test("does not inject when channelCapabilities is null", () => {
    const result = applyRuntimeInjections(baseMessages, {
      channelCapabilities: null,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });

  test("does not inject when channelCapabilities is omitted", () => {
    const result = applyRuntimeInjections(baseMessages, {});

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });

  test("combines with other injections", () => {
    const caps: ChannelCapabilities = {
      channel: "telegram",
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    };

    const result = applyRuntimeInjections(baseMessages, {
      channelCapabilities: caps,
    });

    expect(result.length).toBe(1);
    // channelCapabilities prepends
    expect(result[0].content.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildChannelAwarenessSection
// ---------------------------------------------------------------------------

describe("buildChannelAwarenessSection", () => {
  test("includes channel awareness heading", () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain("## Channel Awareness & Trust Gating");
  });

  test("includes channel-specific rules", () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain("dashboard_capable");
    expect(section).toContain("supports_dynamic_ui");
    expect(section).toContain("supports_voice_input");
  });

  test("includes trust gating rules for permission asks", () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain("firstConversationComplete");
    expect(section).toContain("Permission ask trust gating");
    expect(section).toContain(
      "Do NOT proactively ask for elevated permissions",
    );
  });

  test("gates microphone permissions on voice capability", () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain("Do not ask for microphone permissions");
  });

  test("gates computer-control on dashboard channel", () => {
    const section = buildChannelAwarenessSection();
    expect(section).toContain("computer-control permissions on non-dashboard");
  });
});

// ---------------------------------------------------------------------------
// Trust-gating behavior: channel constraints for permission asks
// ---------------------------------------------------------------------------

describe("trust-gating via channel capabilities", () => {
  test("vellum channel with macos interface does not add constraint rules", () => {
    const caps = resolveChannelCapabilities("vellum", "macos");
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "Enable my microphone" }],
    };

    const result = injectChannelCapabilityContext(message, caps);
    const injected = (result.content[0] as { type: "text"; text: string }).text;

    expect(injected).not.toContain("CHANNEL CONSTRAINTS");
    expect(injected).toContain("dashboard_capable: true");
  });

  test("non-dashboard channel adds constraint rules preventing UI references", () => {
    const caps = resolveChannelCapabilities("slack");
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "Show me a chart" }],
    };

    const result = injectChannelCapabilityContext(message, caps);
    const injected = (result.content[0] as { type: "text"; text: string }).text;

    expect(injected).toContain("CHANNEL CONSTRAINTS");
    expect(injected).toContain("Do NOT reference the dashboard UI");
    expect(injected).toContain("Do NOT use ui_show, ui_update, or app_create");
    expect(injected).toContain("Present information as well-formatted text");
    expect(injected).toContain("desktop app");
  });

  test("vellum web interface allows dynamic UI but constrains dashboard references", () => {
    const caps = resolveChannelCapabilities("vellum", "vellum");
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "Show me a form" }],
    };

    const result = injectChannelCapabilityContext(message, caps);
    const injected = (result.content[0] as { type: "text"; text: string }).text;

    expect(injected).toContain("CHANNEL CONSTRAINTS");
    expect(injected).toContain("Do NOT reference the dashboard UI");
    expect(injected).not.toContain("Do NOT use ui_show");
    expect(injected).not.toContain(
      "Present information as well-formatted text",
    );
    expect(injected).toContain("supports_dynamic_ui: true");
    expect(injected).toContain("dashboard_capable: false");
  });
});

// ---------------------------------------------------------------------------
// injectTemporalContext
// ---------------------------------------------------------------------------

describe("injectTemporalContext", () => {
  const baseUserMessage: Message = {
    role: "user",
    content: [{ type: "text", text: "Plan a trip for next weekend" }],
  };

  const sampleContext =
    "<temporal_context>\nToday: 2026-02-18 (Wednesday)\nTimezone: UTC\n</temporal_context>";

  test("prepends temporal context block to user message", () => {
    const result = injectTemporalContext(baseUserMessage, sampleContext);
    expect(result.content.length).toBe(2);
    const injected = result.content[0];
    expect(injected.type).toBe("text");
    expect((injected as { type: "text"; text: string }).text).toContain(
      "<temporal_context>",
    );
    expect((injected as { type: "text"; text: string }).text).toContain(
      "2026-02-18",
    );
  });

  test("preserves original message content", () => {
    const result = injectTemporalContext(baseUserMessage, sampleContext);
    const lastBlock = result.content[result.content.length - 1];
    expect((lastBlock as { type: "text"; text: string }).text).toBe(
      "Plan a trip for next weekend",
    );
  });
});

// ---------------------------------------------------------------------------
// stripTemporalContext
// ---------------------------------------------------------------------------

describe("stripTemporalContext", () => {
  test("strips temporal_context blocks from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<temporal_context>\nToday: 2026-02-18\n</temporal_context>",
          },
          { type: "text", text: "Hello" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ];

    const result = stripTemporalContext(messages);

    expect(result.length).toBe(2);
    expect(result[0].content.length).toBe(1);
    expect((result[0].content[0] as { type: "text"; text: string }).text).toBe(
      "Hello",
    );
    // Assistant message untouched
    expect(result[1].content.length).toBe(1);
  });

  test("removes user messages that only contain temporal_context", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<temporal_context>\nToday: 2026-02-18\n</temporal_context>",
          },
        ],
      },
    ];

    const result = stripTemporalContext(messages);
    expect(result.length).toBe(0);
  });

  test("does not touch unrelated blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<channel_capabilities>\nchannel: dashboard\n</channel_capabilities>",
          },
          { type: "text", text: "Hello" },
        ],
      },
    ];

    const result = stripTemporalContext(messages);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[0]); // Same reference — untouched
  });

  test("leaves messages without temporal_context untouched", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Normal message" }],
      },
    ];

    const result = stripTemporalContext(messages);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[0]);
  });

  test("preserves user-authored text that starts with <temporal_context> but not the injected prefix", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<temporal_context>some user XML content</temporal_context>",
          },
          { type: "text", text: "Hello" },
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

describe("applyRuntimeInjections with temporalContext", () => {
  const baseMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "When is next weekend?" }],
    },
  ];

  const sampleContext =
    "<temporal_context>\nToday: 2026-02-18 (Wednesday)\n</temporal_context>";

  test("injects temporal context when provided", () => {
    const result = applyRuntimeInjections(baseMessages, {
      temporalContext: sampleContext,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(2);
    const injected = result[0].content[0];
    expect((injected as { type: "text"; text: string }).text).toContain(
      "<temporal_context>",
    );
  });

  test("does not inject when temporalContext is null", () => {
    const result = applyRuntimeInjections(baseMessages, {
      temporalContext: null,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });

  test("does not inject when temporalContext is omitted", () => {
    const result = applyRuntimeInjections(baseMessages, {});

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// inbound_actor_context
// ---------------------------------------------------------------------------

describe("injectInboundActorContext", () => {
  const baseUserMessage: Message = {
    role: "user",
    content: [{ type: "text", text: "Can you text me updates?" }],
  };

  test("prepends inbound_actor_context block to user message", () => {
    const ctx: InboundActorContext = {
      sourceChannel: "voice",
      canonicalActorIdentity: "guardian-user-1",
      actorIdentifier: "+15550001111",
      actorDisplayName: "Guardian Name",
      actorSenderDisplayName: "Guardian Name",
      actorMemberDisplayName: "Guardian Name",
      trustClass: "guardian",
      guardianIdentity: "guardian-user-1",
    };

    const result = injectInboundActorContext(baseUserMessage, ctx);
    expect(result.content.length).toBe(2);
    const injected = result.content[0];
    expect(injected.type).toBe("text");
    const text = (injected as { type: "text"; text: string }).text;
    expect(text).toContain("<inbound_actor_context>");
    expect(text).toContain("trust_class: guardian");
    expect(text).toContain("source_channel: voice");
    expect(text).toContain("canonical_actor_identity: guardian-user-1");
    expect(text).toContain("actor_display_name: Guardian Name");
    expect(text).toContain("actor_sender_display_name: Guardian Name");
    expect(text).toContain("actor_member_display_name: Guardian Name");
    expect(text).toContain("</inbound_actor_context>");
  });

  test("adds nickname guidance when member and sender display names differ", () => {
    const ctx: InboundActorContext = {
      sourceChannel: "telegram",
      canonicalActorIdentity: "trusted-user-1",
      actorIdentifier: "@jeff_handle",
      actorDisplayName: "Jeff",
      actorSenderDisplayName: "Jeffrey",
      actorMemberDisplayName: "Jeff",
      trustClass: "trusted_contact",
      guardianIdentity: "guardian-user-1",
      memberStatus: "active",
      memberPolicy: "allow",
    };

    const result = injectInboundActorContext(baseUserMessage, ctx);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("actor_display_name: Jeff");
    expect(text).toContain("actor_sender_display_name: Jeffrey");
    expect(text).toContain("actor_member_display_name: Jeff");
    expect(text).toContain(
      "name_preference_note: actor_member_display_name is the guardian-preferred nickname",
    );
  });

  test("includes behavioral guidance for trusted_contact actors", () => {
    const ctx: InboundActorContext = {
      sourceChannel: "telegram",
      canonicalActorIdentity: "other-user-1",
      actorIdentifier: "@someone",
      trustClass: "trusted_contact",
      guardianIdentity: "guardian-user-1",
      memberStatus: "active",
      memberPolicy: "default",
    };

    const result = injectInboundActorContext(baseUserMessage, ctx);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("trusted contact (non-guardian)");
    expect(text).toContain("attempt to fulfill it normally");
    expect(text).toContain(
      "tool execution layer will automatically deny it and escalate",
    );
    expect(text).toContain("Do not self-approve");
    expect(text).toContain("Do not explain the verification system");
    expect(text).toContain("member_status: active");
    expect(text).toContain("member_policy: default");
  });

  test("includes behavioral guidance for unknown actors", () => {
    const ctx: InboundActorContext = {
      sourceChannel: "telegram",
      canonicalActorIdentity: null,
      trustClass: "unknown",
      denialReason: "no_identity",
    };

    const result = injectInboundActorContext(baseUserMessage, ctx);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("non-guardian account");
    expect(text).toContain("Do not explain the verification system");
    expect(text).toContain("denial_reason: no_identity");
  });

  test("omits non-guardian behavioral guidance for guardian actors", () => {
    const ctx: InboundActorContext = {
      sourceChannel: "telegram",
      canonicalActorIdentity: "guardian-user-1",
      actorIdentifier: "@guardian",
      trustClass: "guardian",
      guardianIdentity: "guardian-user-1",
    };

    const result = injectInboundActorContext(baseUserMessage, ctx);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("non-guardian account");
  });

  test("omits member_status and member_policy when not provided", () => {
    const ctx: InboundActorContext = {
      sourceChannel: "voice",
      canonicalActorIdentity: "user-1",
      trustClass: "unknown",
      denialReason: "no_binding",
    };

    const result = injectInboundActorContext(baseUserMessage, ctx);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("member_status");
    expect(text).not.toContain("member_policy");
  });
});

describe("stripInboundActorContext", () => {
  test("strips inbound_actor_context blocks from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<inbound_actor_context>\ntrust_class: guardian\n</inbound_actor_context>",
          },
          { type: "text", text: "Hello" },
        ],
      },
    ];
    const result = stripInboundActorContext(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { type: "text"; text: string }).text).toBe(
      "Hello",
    );
  });
});

describe("applyRuntimeInjections with inboundActorContext", () => {
  const baseMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "Help me send this message." }],
    },
  ];

  test("injects inbound actor context when provided", () => {
    const result = applyRuntimeInjections(baseMessages, {
      inboundActorContext: {
        sourceChannel: "voice",
        canonicalActorIdentity: "requester-1",
        actorIdentifier: "+15550002222",
        trustClass: "trusted_contact",
        guardianIdentity: "guardian-1",
        memberStatus: "active",
        memberPolicy: "default",
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect(
      (result[0].content[0] as { type: "text"; text: string }).text,
    ).toContain("<inbound_actor_context>");
  });
});

// ---------------------------------------------------------------------------
// buildChannelTurnContextBlock
// ---------------------------------------------------------------------------

describe("buildChannelTurnContextBlock", () => {
  test("formats block with all three channel fields", () => {
    const block = buildChannelTurnContextBlock({
      turnContext: {
        userMessageChannel: "telegram",
        assistantMessageChannel: "telegram",
      },
      conversationOriginChannel: "telegram",
    });
    expect(block).toBe(
      "<channel_turn_context>\n" +
        "user_message_channel: telegram\n" +
        "assistant_message_channel: telegram\n" +
        "conversation_origin_channel: telegram\n" +
        "</channel_turn_context>",
    );
  });

  test('uses "unknown" when conversationOriginChannel is null', () => {
    const block = buildChannelTurnContextBlock({
      turnContext: {
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
      },
      conversationOriginChannel: null,
    });
    expect(block).toContain("conversation_origin_channel: unknown");
  });

  test("handles mixed channels", () => {
    const block = buildChannelTurnContextBlock({
      turnContext: {
        userMessageChannel: "telegram",
        assistantMessageChannel: "vellum",
      },
      conversationOriginChannel: "vellum",
    });
    expect(block).toContain("user_message_channel: telegram");
    expect(block).toContain("assistant_message_channel: vellum");
    expect(block).toContain("conversation_origin_channel: vellum");
  });
});

// ---------------------------------------------------------------------------
// injectChannelTurnContext
// ---------------------------------------------------------------------------

describe("injectChannelTurnContext", () => {
  const baseUserMessage: Message = {
    role: "user",
    content: [{ type: "text", text: "Hello from telegram" }],
  };

  test("prepends channel_turn_context block to user message", () => {
    const params: ChannelTurnContextParams = {
      turnContext: {
        userMessageChannel: "telegram",
        assistantMessageChannel: "telegram",
      },
      conversationOriginChannel: "telegram",
    };
    const result = injectChannelTurnContext(baseUserMessage, params);
    expect(result.content.length).toBe(2);
    const injected = result.content[0];
    expect(injected.type).toBe("text");
    const text = (injected as { type: "text"; text: string }).text;
    expect(text).toContain("<channel_turn_context>");
    expect(text).toContain("user_message_channel: telegram");
    expect(text).toContain("</channel_turn_context>");
  });

  test("preserves original message content", () => {
    const params: ChannelTurnContextParams = {
      turnContext: {
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
      },
      conversationOriginChannel: "vellum",
    };
    const result = injectChannelTurnContext(baseUserMessage, params);
    const lastBlock = result.content[result.content.length - 1];
    expect((lastBlock as { type: "text"; text: string }).text).toBe(
      "Hello from telegram",
    );
  });
});

// ---------------------------------------------------------------------------
// stripChannelTurnContext
// ---------------------------------------------------------------------------

describe("stripChannelTurnContext", () => {
  test("strips channel_turn_context blocks from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<channel_turn_context>\nuser_message_channel: telegram\n</channel_turn_context>",
          },
          { type: "text", text: "Hello" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ];

    const result = stripChannelTurnContext(messages);

    expect(result.length).toBe(2);
    expect(result[0].content.length).toBe(1);
    expect((result[0].content[0] as { type: "text"; text: string }).text).toBe(
      "Hello",
    );
    expect(result[1].content.length).toBe(1);
  });

  test("removes user messages that only contain channel_turn_context", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<channel_turn_context>\nuser_message_channel: macos\n</channel_turn_context>",
          },
        ],
      },
    ];

    const result = stripChannelTurnContext(messages);
    expect(result.length).toBe(0);
  });

  test("leaves messages without channel_turn_context untouched", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Normal message" }],
      },
    ];

    const result = stripChannelTurnContext(messages);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[0]);
  });
});

// ---------------------------------------------------------------------------
// applyRuntimeInjections with channelTurnContext
// ---------------------------------------------------------------------------

describe("applyRuntimeInjections with channelTurnContext", () => {
  const baseMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "What channel am I on?" }],
    },
  ];

  test("injects channel turn context when provided", () => {
    const params: ChannelTurnContextParams = {
      turnContext: {
        userMessageChannel: "telegram",
        assistantMessageChannel: "telegram",
      },
      conversationOriginChannel: "telegram",
    };

    const result = applyRuntimeInjections(baseMessages, {
      channelTurnContext: params,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(2);
    const injected = result[0].content[0];
    expect((injected as { type: "text"; text: string }).text).toContain(
      "<channel_turn_context>",
    );
  });

  test("does not inject when channelTurnContext is null", () => {
    const result = applyRuntimeInjections(baseMessages, {
      channelTurnContext: null,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });

  test("does not inject when channelTurnContext is omitted", () => {
    const result = applyRuntimeInjections(baseMessages, {});

    expect(result.length).toBe(1);
    expect(result[0].content.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sanitizePttActivationKey
// ---------------------------------------------------------------------------

describe("sanitizePttActivationKey", () => {
  test("returns undefined for null/undefined input", () => {
    expect(sanitizePttActivationKey(null)).toBeUndefined();
    expect(sanitizePttActivationKey(undefined)).toBeUndefined();
  });

  test("passes through valid JSON PTTActivator payloads", () => {
    const modifierOnly = JSON.stringify({
      kind: "modifierOnly",
      modifierFlags: 8388608,
    });
    expect(sanitizePttActivationKey(modifierOnly)).toBe(modifierOnly);
    const keyPayload = JSON.stringify({ kind: "key", keyCode: 49 });
    expect(sanitizePttActivationKey(keyPayload)).toBe(keyPayload);
    const nonePayload = JSON.stringify({ kind: "none" });
    expect(sanitizePttActivationKey(nonePayload)).toBe(nonePayload);
  });

  test("returns undefined for invalid keys", () => {
    expect(
      sanitizePttActivationKey("malicious\nprompt injection"),
    ).toBeUndefined();
    expect(sanitizePttActivationKey("arbitrary_value")).toBeUndefined();
    expect(sanitizePttActivationKey("")).toBeUndefined();
  });

  test("returns undefined for legacy string keys", () => {
    expect(sanitizePttActivationKey("fn")).toBeUndefined();
    expect(sanitizePttActivationKey("ctrl")).toBeUndefined();
    expect(sanitizePttActivationKey("fn_shift")).toBeUndefined();
    expect(sanitizePttActivationKey("none")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveChannelCapabilities sanitizes pttActivationKey
// ---------------------------------------------------------------------------

describe("resolveChannelCapabilities with PTT metadata", () => {
  test("sanitizes valid JSON PTTActivator pttActivationKey", () => {
    const key = JSON.stringify({
      kind: "modifierOnly",
      modifierFlags: 8388608,
    });
    const caps = resolveChannelCapabilities("macos", "macos", {
      pttActivationKey: key,
    });
    expect(caps.pttActivationKey).toBe(key);
  });

  test("sanitizes legacy string pttActivationKey to undefined", () => {
    const caps = resolveChannelCapabilities("macos", "macos", {
      pttActivationKey: "fn",
    });
    expect(caps.pttActivationKey).toBeUndefined();
  });

  test("sanitizes invalid pttActivationKey to undefined", () => {
    const caps = resolveChannelCapabilities("macos", "macos", {
      pttActivationKey: "evil\nprompt",
    });
    expect(caps.pttActivationKey).toBeUndefined();
  });

  test("passes through microphonePermissionGranted", () => {
    const key = JSON.stringify({
      kind: "modifierOnly",
      modifierFlags: 8388608,
    });
    const caps = resolveChannelCapabilities("macos", "macos", {
      pttActivationKey: key,
      microphonePermissionGranted: true,
    });
    expect(caps.microphonePermissionGranted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyRuntimeInjections — injection mode
// ---------------------------------------------------------------------------

describe("applyRuntimeInjections — injection mode", () => {
  const baseMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
  ];

  const fullOptions = {
    workspaceTopLevelContext:
      "<workspace_top_level>\nRoot: /sandbox\n</workspace_top_level>",
    temporalContext:
      "<temporal_context>\nToday: 2026-03-04 (Tuesday)\n</temporal_context>",
    channelCommandContext: { type: "start" } as const,
    activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
    channelCapabilities: {
      channel: "telegram",
      dashboardCapable: false,
      supportsDynamicUi: false,
      supportsVoiceInput: false,
    } as ChannelCapabilities,
    channelTurnContext: {
      turnContext: {
        userMessageChannel: "telegram",
        assistantMessageChannel: "telegram",
      },
      conversationOriginChannel: "telegram",
    } as ChannelTurnContextParams,
    interfaceTurnContext: {
      turnContext: {
        userMessageInterface: "telegram" as const,
        assistantMessageInterface: "telegram" as const,
      },
      conversationOriginInterface: null,
    },
    inboundActorContext: {
      sourceChannel: "telegram",
      canonicalActorIdentity: "user-1",
      trustClass: "guardian",
    } as InboundActorContext,
    isNonInteractive: true,
  };

  test("full mode (default) includes all injections", () => {
    const result = applyRuntimeInjections(baseMessages, fullOptions);
    const allText = result[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    expect(allText).toContain("<workspace_top_level>");
    expect(allText).toContain("<temporal_context>");
    expect(allText).toContain("<channel_command_context>");
    expect(allText).toContain("<active_workspace>");
    expect(allText).toContain("<channel_capabilities>");
    expect(allText).toContain("<channel_turn_context>");
    expect(allText).toContain("<interface_turn_context>");
    expect(allText).toContain("<inbound_actor_context>");
    expect(allText).toContain("<non_interactive_context>");
  });

  test("explicit mode: 'full' behaves the same as default", () => {
    const result = applyRuntimeInjections(baseMessages, {
      ...fullOptions,
      mode: "full",
    });
    const allText = result[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    expect(allText).toContain("<workspace_top_level>");
    expect(allText).toContain("<temporal_context>");
    expect(allText).toContain("<channel_command_context>");
    expect(allText).toContain("<active_workspace>");
  });

  test("minimal mode skips high-token optional blocks", () => {
    const result = applyRuntimeInjections(baseMessages, {
      ...fullOptions,
      mode: "minimal",
    });
    const allText = result[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Skipped in minimal mode
    expect(allText).not.toContain("<workspace_top_level>");
    expect(allText).not.toContain("<temporal_context>");
    expect(allText).not.toContain("<channel_command_context>");
    expect(allText).not.toContain("<active_workspace>");
  });

  test("minimal mode preserves safety-critical blocks", () => {
    const result = applyRuntimeInjections(baseMessages, {
      ...fullOptions,
      mode: "minimal",
    });
    const allText = result[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Kept in minimal mode
    expect(allText).toContain("<channel_turn_context>");
    expect(allText).toContain("<interface_turn_context>");
    expect(allText).toContain("<inbound_actor_context>");
    expect(allText).toContain("<non_interactive_context>");
    expect(allText).toContain("<channel_capabilities>");
  });

  test("minimal mode produces strictly fewer content blocks than full mode", () => {
    const fullResult = applyRuntimeInjections(baseMessages, {
      ...fullOptions,
      mode: "full",
    });
    const minimalResult = applyRuntimeInjections(baseMessages, {
      ...fullOptions,
      mode: "minimal",
    });

    expect(minimalResult[0].content.length).toBeLessThan(
      fullResult[0].content.length,
    );
  });

  test("minimal mode still preserves the original user message text", () => {
    const result = applyRuntimeInjections(baseMessages, {
      ...fullOptions,
      mode: "minimal",
    });
    const texts = result[0].content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);

    expect(texts).toContain("Hello");
  });
});
