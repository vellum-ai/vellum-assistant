/**
 * Tests for `startVoiceTurn`'s conversation-lock wait.
 *
 * The bridge waits on `conversation.waitForIdle` (event-driven, resolved
 * from `setProcessing(false)`) instead of polling `isProcessing()` every
 * 50 ms, so a barge-in turn starts on the same tick the prior turn releases
 * the lock. Because the same transition hands the lock to the prior turn's
 * queued-message drain, the bridge also re-checks the lock when queued work
 * is visible and retries a busy persist once — covered by the drain-race
 * suite below. The call-controller re-prompt path matches on the exact error
 * strings, so those are pinned here too. `waitForIdle`'s own semantics are
 * covered by `src/__tests__/conversation-wait-for-idle.test.ts`.
 */
import {
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing voice-session-bridge
// ---------------------------------------------------------------------------

// Swapped per-test to hand startVoiceTurn a scripted fake conversation.
let fakeConversation: FakeConversation;

mock.module("../../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async () => fakeConversation,
}));

// Conversation-CRUD doubles for the teardown transcript-hygiene pass. The
// real module is spread so every other export keeps its production behavior;
// only the functions the hygiene pass (and discard) touch are recorded.
import * as realConversationCrud from "../../persistence/conversation-crud.js";

let getMessageByIdImpl: (
  messageId: string,
  conversationId?: string,
) => unknown = () => null;
const crudLog: {
  reads: string[];
  updates: Array<{ messageId: string; content: string }>;
  deletes: string[];
} = { reads: [], updates: [], deletes: [] };
function resetCrudLog(): void {
  crudLog.reads.length = 0;
  crudLog.updates.length = 0;
  crudLog.deletes.length = 0;
  getMessageByIdImpl = () => null;
}

mock.module("../../persistence/conversation-crud.js", () => ({
  ...realConversationCrud,
  getMessageById: (messageId: string, conversationId?: string) => {
    crudLog.reads.push(messageId);
    return getMessageByIdImpl(messageId, conversationId);
  },
  updateMessageContent: (messageId: string, content: string) => {
    crudLog.updates.push({ messageId, content });
  },
  deleteMessageById: (messageId: string) => {
    crudLog.deletes.push(messageId);
    return { segmentIds: [], deletedSummaryIds: [] };
  },
  // The echo path advances the snapshot anchor for a real-user turn; the
  // fake conversation has no row in SQLite, so stub the write out.
  recordConversationPersistedSeq: () => {},
}));

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { ABORT_WATCHDOG_MS } from "../../daemon/abort-watchdog.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import {
  CALL_OPENING_MARKER,
  ESCALATE_VERDICT_TOKEN,
  HOLD_VERDICT_TOKEN,
} from "../voice-control-protocol.js";
import {
  cutFrontDoorContentAtVerdict,
  preSpeechLanguageRuleFragment,
  startVoiceTurn,
  TOOL_RESULT_PREVIEW_MAX_CHARS,
  type VoiceTurnOptions,
} from "../voice-session-bridge.js";
import {
  escalatedContinuationRule,
  ESCALATION_CONTINUATION_CONTENT,
  frontDoorDecisionRule,
} from "../voice-triage-escalate.js";

// `resolveProcessingWaitMs` reads `workspaceGit.turnCommitMaxWaitMs`; seed it
// so the wait-budget assertions below get a fixed, known value.
setConfig("workspaceGit", { turnCommitMaxWaitMs: 100 });

// ---------------------------------------------------------------------------
// Fake conversation
// ---------------------------------------------------------------------------

interface WaitForIdleCall {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface FakeConversation {
  conversationId: string;
  callSessionId: string | undefined;
  forcePromptSideEffects: boolean;
  currentRequestId: string | undefined;
  isProcessing: () => boolean;
  hasQueuedMessages?: () => boolean;
  waitForIdle: (options: WaitForIdleCall) => Promise<boolean>;
  setAssistantId: (id: string) => void;
  setTrustContext: (ctx: unknown) => void;
  setCommandIntent: (intent: unknown) => void;
  setTurnChannelContext: (ctx: unknown) => void;
  setTurnInterfaceContext: (ctx: unknown) => void;
  setChannelCapabilities: (caps: unknown) => void;
  setVoiceCallControlPrompt: (prompt: string | null) => void;
  persistUserMessage: (opts: {
    content: string;
    requestId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id: string }>;
  workingDir: string;
  updateClient: (cb: unknown, reset?: boolean) => void;
  handleConfirmationResponse: (
    requestId: string,
    decision: string,
    opts?: { decisionContext?: string },
  ) => void;
  runAgentLoop: (...args: unknown[]) => Promise<void>;
  abort: (reason?: unknown) => void;
  loadFromDb: () => Promise<void>;
  toolsDisabledDepth: number;
}

function makeFakeConversation(opts: {
  processing: boolean;
  waitForIdle?: (options: WaitForIdleCall) => Promise<boolean>;
  runAgentLoop?: () => Promise<void>;
  events?: string[];
  /** Mirrors `Conversation.hasQueuedMessages`; undefined models an empty queue. */
  hasQueuedMessages?: () => boolean;
  /** Runs before each persist resolves; throw to script a persist failure. */
  onPersist?: (attempt: number) => void;
  /** Workspace root; pass empty to model a missing boundary. */
  workingDir?: string;
}) {
  const waitForIdleCalls: WaitForIdleCall[] = [];
  const confirmationDecisions: Array<{ requestId: string; decision: string }> =
    [];
  let clientCallback: ((msg: unknown) => Promise<void>) | undefined;
  let persistCount = 0;
  let lastPersistOpts:
    | { content: string; requestId: string; metadata?: Record<string, unknown> }
    | undefined;
  const conversation: FakeConversation = {
    conversationId: "conv-voice-bridge-test",
    // The workspace boundary the reach check compares paths against. A real
    // conversation always has one; without it the approval gate fails closed.
    workingDir: opts.workingDir ?? "/tmp/workspace-voice-bridge-test",
    callSessionId: undefined,
    forcePromptSideEffects: false,
    currentRequestId: undefined,
    isProcessing: () => opts.processing,
    hasQueuedMessages: opts.hasQueuedMessages,
    waitForIdle: (options) => {
      waitForIdleCalls.push(options);
      if (!opts.waitForIdle) {
        throw new Error("waitForIdle not scripted for this test");
      }
      return opts.waitForIdle(options);
    },
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    setChannelCapabilities: () => {},
    setVoiceCallControlPrompt: () => {},
    persistUserMessage: async (persistOpts) => {
      persistCount += 1;
      lastPersistOpts = persistOpts;
      // Recorded before `onPersist` so scripted persist FAILURES also
      // appear in the event stream — ordering tests need the losing
      // attempt visible.
      opts.events?.push("persist");
      opts.onPersist?.(persistCount);
      return { id: `msg-${persistCount}` };
    },
    // The install (reset falsy) / reset (reset true) pair marks a turn
    // taking ownership of the conversation vs a turn's cleanup releasing it.
    updateClient: (cb, reset) => {
      opts.events?.push(reset ? "client:reset" : "client:install");
      if (reset !== true) {
        clientCallback = cb as (msg: unknown) => Promise<void>;
      }
    },
    handleConfirmationResponse: (requestId, decision) => {
      confirmationDecisions.push({ requestId, decision });
    },
    runAgentLoop: () => (opts.runAgentLoop ?? (async () => {}))(),
    abort: () => {},
    loadFromDb: async () => {
      opts.events?.push("loadFromDb");
    },
    toolsDisabledDepth: 0,
  };
  return {
    conversation,
    waitForIdleCalls,
    confirmationDecisions,
    /** Deliver an event the way the conversation would, to the installed handler. */
    emitToClient: async (msg: unknown) => {
      await clientCallback?.(msg);
    },
    persistCount: () => persistCount,
    lastPersistOpts: () => lastPersistOpts,
    setProcessingFlag: (value: boolean) => {
      opts.processing = value;
    },
  };
}

/**
 * The full set of per-turn conversation values the bridge snapshots and
 * restores when it loses the persist race (see `restoreTurnState` in
 * voice-session-bridge.ts).
 */
interface FakeTurnState {
  assistantId: string | undefined;
  callSessionId: string | undefined;
  trustContext: unknown;
  commandIntent: unknown;
  turnChannelContext: unknown;
  turnInterfaceContext: unknown;
  channelCapabilities: unknown;
  voiceCallControlPrompt: string | undefined;
  forcePromptSideEffects: boolean;
}

/**
 * Wire stateful setters/getters onto a fake conversation, mirroring the real
 * Conversation's field semantics (a null setter argument clears the field to
 * undefined; turn contexts store null as-is), so the bridge's
 * snapshot/restore logic reads and writes live values. Returns a reader for
 * the conversation's current turn state.
 */
function wireTurnState(
  fake: FakeConversation,
  initial: Partial<FakeTurnState>,
): () => FakeTurnState {
  const conv = fake as FakeConversation & {
    assistantId?: string;
    trustContext?: unknown;
    commandIntent?: unknown;
    channelCapabilities?: unknown;
    voiceCallControlPrompt?: string;
    getTurnChannelContext?: () => unknown;
    getTurnInterfaceContext?: () => unknown;
  };
  conv.assistantId = initial.assistantId;
  conv.callSessionId = initial.callSessionId;
  conv.trustContext = initial.trustContext;
  conv.commandIntent = initial.commandIntent;
  conv.channelCapabilities = initial.channelCapabilities;
  conv.voiceCallControlPrompt = initial.voiceCallControlPrompt;
  conv.forcePromptSideEffects = initial.forcePromptSideEffects ?? false;
  let turnChannelContext: unknown = initial.turnChannelContext ?? null;
  let turnInterfaceContext: unknown = initial.turnInterfaceContext ?? null;
  conv.setAssistantId = (id: string | null) => {
    conv.assistantId = id ?? undefined;
  };
  conv.setTrustContext = (ctx: unknown) => {
    conv.trustContext = ctx ?? undefined;
  };
  conv.setCommandIntent = (intent: unknown) => {
    conv.commandIntent = intent ?? undefined;
  };
  conv.setChannelCapabilities = (caps: unknown) => {
    conv.channelCapabilities = caps ?? undefined;
  };
  conv.setVoiceCallControlPrompt = (prompt: string | null) => {
    conv.voiceCallControlPrompt = prompt ?? undefined;
  };
  conv.setTurnChannelContext = (ctx: unknown) => {
    turnChannelContext = ctx;
  };
  conv.setTurnInterfaceContext = (ctx: unknown) => {
    turnInterfaceContext = ctx;
  };
  conv.getTurnChannelContext = () => turnChannelContext;
  conv.getTurnInterfaceContext = () => turnInterfaceContext;
  return () => ({
    assistantId: conv.assistantId,
    callSessionId: conv.callSessionId,
    trustContext: conv.trustContext,
    commandIntent: conv.commandIntent,
    turnChannelContext,
    turnInterfaceContext,
    channelCapabilities: conv.channelCapabilities,
    voiceCallControlPrompt: conv.voiceCallControlPrompt,
    forcePromptSideEffects: conv.forcePromptSideEffects,
  });
}

/**
 * Winner-like per-turn state: the values a concurrent turn (e.g. a drained
 * text turn from an iMessage channel) would have installed before this voice
 * turn's persist lost the race to it.
 */
function makeWinnerState(): FakeTurnState {
  return {
    assistantId: "assistant-winner",
    callSessionId: "session-winner",
    trustContext: { sourceChannel: "imessage", trustClass: "trusted_contact" },
    commandIntent: undefined,
    turnChannelContext: {
      userMessageChannel: "imessage",
      assistantMessageChannel: "imessage",
    },
    turnInterfaceContext: {
      userMessageInterface: "channel",
      assistantMessageInterface: "channel",
    },
    channelCapabilities: { channel: "imessage", supportsDynamicUi: false },
    voiceCallControlPrompt: "winner control prompt",
    forcePromptSideEffects: false,
  };
}

function makeTurnOptions(signal?: AbortSignal, conversationId?: string) {
  return {
    conversationId: conversationId ?? "conv-voice-bridge-test",
    // The synthetic opener marker keeps the turn off the user-echo
    // broadcast path (no event-hub / persisted-seq side effects in tests).
    content: CALL_OPENING_MARKER,
    isInbound: true,
    signal,
  };
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startVoiceTurn escalation-continuation persistence", () => {
  test("persists the escalation-continuation prompt as a hidden row", async () => {
    // The continuation is a pure internal instruction — it must be persisted
    // `hidden` so `/messages` filters it out of the transcript after a reload,
    // not merely echo-suppressed live.
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    await startVoiceTurn({
      ...makeTurnOptions(),
      content: ESCALATION_CONTINUATION_CONTENT,
    });

    expect(fake.lastPersistOpts()?.content).toBe(
      ESCALATION_CONTINUATION_CONTENT,
    );
    expect(fake.lastPersistOpts()?.metadata).toEqual({
      voiceSessionTurn: true,
      hidden: true,
    });
  });

  test("the opener prompt is persisted un-hidden (unchanged)", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions()); // content: CALL_OPENING_MARKER

    expect(fake.lastPersistOpts()?.metadata).toEqual({
      voiceSessionTurn: true,
    });
  });

  test("a live-voice turn persists its session attribution under metadata.client", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    await startVoiceTurn({
      ...makeTurnOptions(),
      voiceTelemetry: { sessionId: "session-123", client: "ios" },
    });

    // `turn-events-store` projects `$.client` onto `TurnTelemetryEvent.client`,
    // so this bag is what makes a voice turn countable per client and joinable
    // to its session's funnel rows. The platform goes in `os`, the same key
    // the HTTP send path fills, so voice turns sit in the column existing turn
    // analytics already read.
    expect(fake.lastPersistOpts()?.metadata).toEqual({
      voiceSessionTurn: true,
      client: {
        voice: true,
        voice_session_id: "session-123",
        os: "ios",
      },
    });
  });

  test("omits the client key when the session reported no originating client", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    await startVoiceTurn({
      ...makeTurnOptions(),
      voiceTelemetry: { sessionId: "session-123" },
    });

    expect(fake.lastPersistOpts()?.metadata).toEqual({
      voiceSessionTurn: true,
      client: { voice: true, voice_session_id: "session-123" },
    });
  });

  test("a phone turn carries no client bag", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions());

    // Only live-voice sessions pass `voiceTelemetry`; a phone call has no
    // live-voice session id to attribute a turn to.
    expect(fake.lastPersistOpts()?.metadata).not.toHaveProperty("client");
  });
});

describe("startVoiceTurn hiddenSyntheticPrompt", () => {
  // A caller whose internal instruction is composed per call carries no
  // sentinel for the content comparisons to recognize, so it declares itself.
  const SYNTHETIC_CONTENT =
    "(the background task finished — announce the result)";

  /** The `user_message_echo` events `turn` publishes to hub subscribers. */
  async function collectUserMessageEchoes(
    turn: () => Promise<unknown>,
  ): Promise<Array<{ type: string }>> {
    const published: Array<{ type: string }> = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: { conversationId: "conv-voice-bridge-test" },
      callback: (event) => {
        published.push(event.message);
      },
    });
    try {
      await turn();
    } finally {
      subscription.dispose();
    }
    return published.filter((msg) => msg.type === "user_message_echo");
  }

  test("a declared prompt persists hidden and suppresses its echo", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    const echoes = await collectUserMessageEchoes(() =>
      startVoiceTurn({
        ...makeTurnOptions(),
        content: SYNTHETIC_CONTENT,
        hiddenSyntheticPrompt: true,
      }),
    );

    expect(fake.lastPersistOpts()?.content).toBe(SYNTHETIC_CONTENT);
    expect(fake.lastPersistOpts()?.metadata).toEqual({
      voiceSessionTurn: true,
      hidden: true,
    });
    expect(echoes).toHaveLength(0);
  });

  test("the same content without the flag stays a plain user turn", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    const echoes = await collectUserMessageEchoes(() =>
      startVoiceTurn({
        ...makeTurnOptions(),
        content: SYNTHETIC_CONTENT,
      }),
    );

    expect(fake.lastPersistOpts()?.metadata).toEqual({
      voiceSessionTurn: true,
    });
    expect(echoes).toEqual([
      expect.objectContaining({ text: SYNTHETIC_CONTENT }),
    ]);
  });
});

// The turn installs its resolved control prompt, then cleanup resets it to
// null, so capture every applied value and read the installed (non-null) one.
function captureInstalledPrompt(): () => string | undefined {
  const fake = makeFakeConversation({ processing: false });
  fakeConversation = fake.conversation;
  const applied: Array<string | null> = [];
  fake.conversation.setVoiceCallControlPrompt = (prompt) => {
    applied.push(prompt);
  };
  return () => applied.find((p): p is string => typeof p === "string");
}

describe("startVoiceTurn triage-and-escalate control prompt", () => {
  // Live-voice supplies its own voiceControlPrompt, bypassing
  // buildVoiceCallControlPrompt where the routing-leg rule is normally injected.
  // The rule must still be appended, or the front-door model never learns the
  // verdict protocol and can't hold or hand off.
  const LIVE_VOICE_PROMPT = "You are speaking in a local live voice session.";

  test("appends the front-door decision rule to a caller-supplied prompt", async () => {
    const installed = captureInstalledPrompt();
    await startVoiceTurn({
      ...makeTurnOptions(),
      voiceControlPrompt: LIVE_VOICE_PROMPT,
      routingLeg: "front-door",
    });
    expect(installed()).toContain(LIVE_VOICE_PROMPT);
    expect(installed()).toContain(frontDoorDecisionRule());
  });

  test("a speculative front-door leg's rule includes the hold branch", async () => {
    const installed = captureInstalledPrompt();
    await startVoiceTurn({
      ...makeTurnOptions(),
      voiceControlPrompt: LIVE_VOICE_PROMPT,
      routingLeg: "front-door",
      unifiedVerdict: true,
    });
    expect(installed()).toContain(frontDoorDecisionRule({ includeHold: true }));
  });

  test("appends the escalated continuation rule to a caller-supplied prompt", async () => {
    const installed = captureInstalledPrompt();
    await startVoiceTurn({
      ...makeTurnOptions(),
      voiceControlPrompt: LIVE_VOICE_PROMPT,
      routingLeg: "escalated",
    });
    expect(installed()).toContain(LIVE_VOICE_PROMPT);
    expect(installed()).toContain(escalatedContinuationRule());
  });

  test("leaves a caller-supplied prompt verbatim when no routing leg is set", async () => {
    const installed = captureInstalledPrompt();
    await startVoiceTurn({
      ...makeTurnOptions(),
      voiceControlPrompt: LIVE_VOICE_PROMPT,
    });
    expect(installed()).toBe(LIVE_VOICE_PROMPT);
  });
});

describe("default call protocol numbered rules", () => {
  // With no caller-supplied voiceControlPrompt the bridge builds the numbered
  // CALL PROTOCOL RULES itself. Pin the speak-the-caller's-language rule and
  // keep the numbering gapless so no rule silently shadows another.
  test("teaches speaking the caller's language as its own numbered rule", async () => {
    const installed = captureInstalledPrompt();
    await startVoiceTurn(makeTurnOptions());
    expect(installed()).toContain(
      "12. Speak the caller's language: reply in the language of the caller's most recent actual speech, and follow them if they switch languages mid-call. Synthetic user turns (parenthetical markers like the call-connected and verification-completed notices) are not caller speech and never set the language. Before the caller has spoken, such as on the opening greeting turn, use the language the Task context implies, if any; otherwise default to English.",
    );
  });

  test("the language rule excludes synthetic turns and covers pre-speech turns", async () => {
    // Outbound calls open with the English "(call connected ...)" sentinel as
    // the latest user-role turn, and the verification-complete sentinel does
    // the same mid-call. Neither is caller speech, so neither may pull a
    // Spanish or Japanese Task into an English opener.
    const installed = captureInstalledPrompt();
    await startVoiceTurn(makeTurnOptions());
    const prompt = installed()!;
    expect(prompt).toContain("most recent actual speech");
    expect(prompt).toContain("not caller speech and never set the language");
    expect(prompt).toContain(
      "use the language the Task context implies, if any; otherwise default to English",
    );
  });

  test("a monolingual listening language becomes the pre-speech fallback", () => {
    // An assistant pinned to services.stt.language = "es" on a provider that
    // honors the pin (deepgram, vellum) is already transcribing Spanish, so
    // the opener must not default to English. The default test config runs
    // the auto-detect branch ("multi"), so the pinned branch is covered at
    // the fragment level.
    expect(preSpeechLanguageRuleFragment("es", "deepgram")).toContain(
      'configured listening language ("es")',
    );
    expect(preSpeechLanguageRuleFragment("es", "vellum")).toContain(
      "default to English only when neither gives a language",
    );
    for (const autoDetect of ["multi", "", "  ", undefined]) {
      expect(preSpeechLanguageRuleFragment(autoDetect, "deepgram")).toBe(
        "use the language the Task context implies, if any; otherwise default to English",
      );
    }
  });

  test("a language pin on an auto-detecting provider keeps the English fallback", () => {
    // google-gemini and openai-whisper ignore services.stt.language entirely
    // (languageSelection: "auto"), so a persisted "es" pin must not force a
    // Spanish greeting the transcriber will not honor.
    for (const provider of ["google-gemini", "openai-whisper", undefined]) {
      expect(preSpeechLanguageRuleFragment("es", provider)).toBe(
        "use the language the Task context implies, if any; otherwise default to English",
      );
    }
  });

  test("rule numbers stay sequential from 0, including the routing rule", async () => {
    const installed = captureInstalledPrompt();
    await startVoiceTurn({ ...makeTurnOptions(), routingLeg: "escalated" });
    const numbers = [...installed()!.matchAll(/^(\d+)\. /gm)].map((match) =>
      Number(match[1]),
    );
    expect(numbers.length).toBeGreaterThan(12);
    expect(numbers).toEqual(numbers.map((_, index) => index));
  });
});

describe("startVoiceTurn channel capabilities", () => {
  // Whether a call can show a surface is a property of its channel, not of
  // calls in general, so the bridge applies no voice-specific override: a
  // phone call has no screen and resolves false on its own, while a live-voice
  // call is a screen the user is holding and resolves true.

  // The turn installs its capabilities, then cleanup resets them to null — so
  // capture every applied value and read the installed (non-null) one.
  function captureInstalledCapabilities(): () =>
    | Record<string, unknown>
    | undefined {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;
    const applied: unknown[] = [];
    fake.conversation.setChannelCapabilities = (caps) => {
      applied.push(caps);
    };
    return () =>
      applied.find(
        (caps): caps is Record<string, unknown> =>
          caps != null && typeof caps === "object",
      );
  }

  test("a vellum/macos (live-voice) turn keeps its channel's dynamic UI", async () => {
    const installed = captureInstalledCapabilities();
    await startVoiceTurn({
      ...makeTurnOptions(),
      userMessageChannel: "vellum",
      userMessageInterface: "macos",
    });
    const caps = installed();
    expect(caps?.supportsDynamicUi).toBe(true);
    // Nothing else about the channel is rewritten either.
    expect(caps?.dashboardCapable).toBe(true);
    expect(caps?.supportsVoiceInput).toBe(true);
    expect(caps?.clientOS).toBe("macos");
  });

  // The case the removed override existed for, still covered: a phone call has
  // no screen to show a surface on, and says so through its channel.
  test("phone defaults yield supportsDynamicUi false", async () => {
    const installed = captureInstalledCapabilities();
    await startVoiceTurn(makeTurnOptions());
    const caps = installed();
    expect(caps?.channel).toBe("phone");
    expect(caps?.supportsDynamicUi).toBe(false);
  });
});

describe("startVoiceTurn guardian approvals", () => {
  function confirmationRequest(
    toolName: string,
    executionTarget?: "sandbox" | "host",
    input: Record<string, unknown> = {},
  ) {
    return {
      type: "confirmation_request",
      requestId: "req-1",
      toolName,
      input,
      riskLevel: "medium",
      allowlistOptions: [],
      scopeOptions: [],
      ...(executionTarget !== undefined ? { executionTarget } : {}),
    };
  }

  async function runVoiceTurn(
    overrides: Partial<VoiceTurnOptions>,
    conversationOpts: { workingDir?: string } = {},
  ) {
    const fake = makeFakeConversation({
      processing: false,
      ...conversationOpts,
    });
    fakeConversation = fake.conversation;
    const pendingAnnounced: string[] = [];
    await startVoiceTurn({
      ...makeTurnOptions(),
      trustContext: { trustClass: "guardian" },
      onApprovalPending: (requestId: string) => {
        pendingAnnounced.push(requestId);
      },
      ...overrides,
    } as VoiceTurnOptions);
    return { ...fake, pendingAnnounced };
  }

  // A live-voice call has a screen, so a tool that reaches the workspace or
  // the host is put to the user rather than decided for them. This is the hole
  // it closes: a guardian call used to allow every confirmation outright.
  test("leaves a sensitive tool pending for the user to answer", async () => {
    const fake = await runVoiceTurn({
      userMessageChannel: "vellum",
      userMessageInterface: "macos",
    });

    await fake.emitToClient(confirmationRequest("bash", "host"));

    expect(fake.confirmationDecisions).toEqual([]);
    // The card renders in the app, and the call covers the app, so a pending
    // decision has to be announced or the turn just goes quiet.
    expect(fake.pendingAnnounced).toEqual(["req-1"]);
  });

  // The tools that read or render were never the reason approval exists, and
  // gating them would interrupt the conversation constantly.
  test("still allows a tool with no sensitive reach", async () => {
    const fake = await runVoiceTurn({
      userMessageChannel: "vellum",
      userMessageInterface: "macos",
    });

    await fake.emitToClient(confirmationRequest("ui_show", "sandbox"));

    expect(fake.confirmationDecisions).toEqual([
      { requestId: "req-1", decision: "allow" },
    ]);
    // Nothing is waiting, so nothing interrupts the call.
    expect(fake.pendingAnnounced).toEqual([]);
  });

  // There is no screen on a phone call, so a prompt there is a question nobody
  // can answer.
  test("a phone call keeps allowing sensitive tools outright", async () => {
    const fake = await runVoiceTurn({ userMessageChannel: "phone" });

    await fake.emitToClient(confirmationRequest("bash", "host"));

    expect(fake.confirmationDecisions).toEqual([
      { requestId: "req-1", decision: "allow" },
    ]);
  });

  // The escape this gate exists to catch: a *sandbox* file tool pointed
  // outside the workspace reaches the host filesystem on a non-containerized
  // install. The reach check can only see that when it is given the workspace
  // boundary; without it this read of a host file classifies as `none` and
  // lands on the auto-allow.
  test("an out-of-workspace path prompts even on a sandbox target", async () => {
    const fake = await runVoiceTurn(
      { userMessageChannel: "vellum", userMessageInterface: "macos" },
      { workingDir: "/tmp/workspace-voice-bridge-test" },
    );

    await fake.emitToClient(
      confirmationRequest("file_read", "sandbox", { path: "/etc/hosts" }),
    );

    expect(fake.confirmationDecisions).toEqual([]);
  });

  // A path inside the workspace is the ordinary case, and gating it would
  // interrupt the conversation for every file the assistant touches.
  test("an in-workspace read is still allowed outright", async () => {
    const fake = await runVoiceTurn(
      { userMessageChannel: "vellum", userMessageInterface: "macos" },
      { workingDir: "/tmp/workspace-voice-bridge-test" },
    );

    await fake.emitToClient(
      confirmationRequest("file_read", "sandbox", {
        path: "/tmp/workspace-voice-bridge-test/notes.md",
      }),
    );

    expect(fake.confirmationDecisions).toEqual([
      { requestId: "req-1", decision: "allow" },
    ]);
  });

  // With no boundary there is no way to tell an ordinary write from an escape,
  // and the safe reading of "cannot tell" is "ask".
  test("a missing workspace boundary fails closed", async () => {
    const fake = await runVoiceTurn(
      { userMessageChannel: "vellum", userMessageInterface: "macos" },
      { workingDir: "" },
    );

    await fake.emitToClient(confirmationRequest("ui_show", "sandbox"));

    expect(fake.confirmationDecisions).toEqual([]);
  });

  // Requests from the proxy and network prompters carry no target. Unknown
  // reads as the more consequential of the two: a prompt the user did not need
  // costs less than an unreviewed action on their machine.
  test("prompts when the execution target is unknown", async () => {
    const fake = await runVoiceTurn({
      userMessageChannel: "vellum",
      userMessageInterface: "macos",
    });

    await fake.emitToClient(confirmationRequest("bash"));

    expect(fake.confirmationDecisions).toEqual([]);
  });
});

describe("startVoiceTurn conversation-lock wait", () => {
  test("an idle conversation starts the turn without consulting waitForIdle", async () => {
    const fake = makeFakeConversation({ processing: false });
    fakeConversation = fake.conversation;

    const handle = await startVoiceTurn(makeTurnOptions());

    expect(handle.turnId).toBeString();
    expect(fake.waitForIdleCalls.length).toBe(0);
    expect(fake.persistCount()).toBe(1);
  });

  test("the turn starts on the same tick the prior turn releases the lock", async () => {
    let release!: (idle: boolean) => void;
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    fakeConversation = fake.conversation;

    const turnPromise = startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();
    expect(fake.persistCount()).toBe(0);

    // Release the lock, then flush ONLY microtasks — no timers. The old
    // 50 ms poll loop could not reach persistUserMessage this way.
    release(true);
    await flushMicrotasks();
    expect(fake.persistCount()).toBe(1);

    await turnPromise;
  });

  test("passes the full processing-wait budget and the abort signal to waitForIdle", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: async () => true,
    });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions(controller.signal));

    expect(fake.waitForIdleCalls.length).toBe(1);
    // turnCommitMaxWaitMs (100, from the config mock) + abort watchdog +
    // 1000 ms margin — see resolveProcessingWaitMs.
    expect(fake.waitForIdleCalls[0]!.timeoutMs).toBe(
      100 + ABORT_WATCHDOG_MS + 1000,
    );
    expect(fake.waitForIdleCalls[0]!.signal).toBe(controller.signal);
  });

  test("a timed-out wait throws the exact already-processing error", async () => {
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: async () => false,
    });
    fakeConversation = fake.conversation;

    await expect(startVoiceTurn(makeTurnOptions())).rejects.toThrow(
      "Conversation is already processing a message",
    );
    expect(fake.persistCount()).toBe(0);
  });

  test("an abort mid-wait throws the exact turn-aborted error", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: ({ signal }) =>
        new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    fakeConversation = fake.conversation;

    const turnPromise = startVoiceTurn(makeTurnOptions(controller.signal));
    // Let the turn reach the waitForIdle suspension point, then abort.
    await flushMicrotasks();
    controller.abort();
    await expect(turnPromise).rejects.toThrow(
      "Turn aborted while waiting for conversation",
    );
    expect(fake.persistCount()).toBe(0);
  });

  test("a signal aborted despite the lock releasing still throws the turn-aborted error", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: async () => {
        // The lock released and the abort landed in the same window: the
        // bridge must still honor the abort rather than start the turn.
        controller.abort();
        return true;
      },
    });
    fakeConversation = fake.conversation;

    await expect(
      startVoiceTurn(makeTurnOptions(controller.signal)),
    ).rejects.toThrow("Turn aborted while waiting for conversation");
    expect(fake.persistCount()).toBe(0);
  });
});

describe("startVoiceTurn prior-turn teardown barrier", () => {
  test("the next turn waits for the prior turn's cleanup before installing its state", async () => {
    const events: string[] = [];
    let releaseAgentLoop!: () => void;
    const fake = makeFakeConversation({
      // The processing flag is already false — modeling the window after
      // `setProcessing(false)` fired the idle waiters but before the prior
      // turn's agent-loop continuation ran `finally { cleanup() }`.
      processing: false,
      events,
      runAgentLoop: () =>
        new Promise<void>((resolve) => {
          releaseAgentLoop = resolve;
        }),
    });
    fakeConversation = fake.conversation;

    // Turn 1 starts and suspends inside its agent loop.
    await startVoiceTurn(makeTurnOptions(undefined, "conv-teardown-order"));
    await flushMicrotasks();
    expect(events).toEqual(["persist", "client:install"]);

    // Turn 2 arrives during the teardown window: it must not persist or
    // install its client callback until turn 1's cleanup has run.
    const turn2 = startVoiceTurn(
      makeTurnOptions(undefined, "conv-teardown-order"),
    );
    await flushMicrotasks();
    expect(events).toEqual(["persist", "client:install"]);

    releaseAgentLoop();
    await flushMicrotasks();
    await turn2;
    // Turn 1's cleanup (client:reset) strictly precedes turn 2's persist
    // and install — the state clobber the barrier exists to prevent.
    expect(events).toEqual([
      "persist",
      "client:install",
      "client:reset",
      "persist",
      "client:install",
    ]);
  });

  test("a queued drain that retakes the lock after teardown is also waited out", async () => {
    let releaseAgentLoop!: () => void;
    const fake = makeFakeConversation({
      processing: false,
      runAgentLoop: () =>
        new Promise<void>((resolve) => {
          releaseAgentLoop = resolve;
        }),
      // The prior turn's queued-message drain holds the lock when turn 2
      // clears the teardown barrier; waitForIdle releases it.
      waitForIdle: async () => {
        fake.setProcessingFlag(false);
        return true;
      },
    });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions(undefined, "conv-teardown-requeue"));
    expect(fake.persistCount()).toBe(1);

    const turn2 = startVoiceTurn(
      makeTurnOptions(undefined, "conv-teardown-requeue"),
    );
    await flushMicrotasks();
    expect(fake.persistCount()).toBe(1);

    // The drain retakes the lock in the same window the teardown settles.
    fake.setProcessingFlag(true);
    releaseAgentLoop();
    await flushMicrotasks();
    await turn2;

    // Turn 2 consulted waitForIdle for the retaken lock instead of
    // failing inside persistUserMessage.
    expect(fake.waitForIdleCalls.length).toBe(1);
    expect(fake.persistCount()).toBe(2);
  });

  test("an abort while waiting on a wedged prior teardown throws the turn-aborted error", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: false,
      // Wedged: the prior turn's agent loop never settles, so its
      // teardown never runs.
      runAgentLoop: () => new Promise<void>(() => {}),
    });
    fakeConversation = fake.conversation;

    await startVoiceTurn(makeTurnOptions(undefined, "conv-teardown-wedged"));
    expect(fake.persistCount()).toBe(1);

    const turn2 = startVoiceTurn(
      makeTurnOptions(controller.signal, "conv-teardown-wedged"),
    );
    await flushMicrotasks();
    controller.abort();
    await expect(turn2).rejects.toThrow(
      "Turn aborted while waiting for conversation",
    );
    expect(fake.persistCount()).toBe(1);
  });
});

describe("startVoiceTurn queued-message drain race", () => {
  test("a drain that retakes the lock on the idle transition is waited out", async () => {
    // Models a prior NON-voice turn (no teardown entry) finishing with a
    // queued text message: the same `finally` that resolves the idle wait
    // hands the lock straight to `drainQueue`. The barge-in must wait the
    // drained turn out within its budget — not race the drain's persist or
    // throw the terminal busy error.
    let waitCount = 0;
    const fake = makeFakeConversation({
      processing: true,
      hasQueuedMessages: () => waitCount < 2,
      waitForIdle: async () => {
        waitCount += 1;
        if (waitCount === 1) {
          // The prior turn released, and its queued-message drain retook
          // the lock in the same window — isProcessing() stays true.
          return true;
        }
        // The drained turn completed; the lock releases for real.
        fake.setProcessingFlag(false);
        return true;
      },
    });
    fakeConversation = fake.conversation;

    const handle = await startVoiceTurn(makeTurnOptions());

    expect(handle.turnId).toBeString();
    expect(fake.waitForIdleCalls.length).toBe(2);
    expect(fake.persistCount()).toBe(1);
  });

  test("a persist that loses the lock race to the drain waits and retries once", async () => {
    // TOCTOU: the wait loop saw an idle conversation with no visible queued
    // work, but the drain's persist took the lock before this turn's persist
    // ran. The first persist throws the exact busy error; the bridge
    // uninstalls its voice turn state, waits for idle, re-installs, and
    // retries the persist once.
    const events: string[] = [];
    const fake = makeFakeConversation({
      processing: false,
      events,
      waitForIdle: async () => {
        events.push("wait:resolved");
        // The drained turn completes during the retry wait.
        fake.setProcessingFlag(false);
        return true;
      },
      onPersist: (attempt) => {
        if (attempt === 1) {
          fake.setProcessingFlag(true);
          throw new Error("Conversation is already processing a message");
        }
      },
    });
    // Record install/uninstall markers for the state the drained turn must
    // never see: the phone control prompt and the caller trust context.
    // The markers also store the value: the bridge's per-field
    // compare-and-restore only reverts a field that still holds the value
    // this turn installed.
    const conv = fake.conversation as unknown as {
      voiceCallControlPrompt?: string;
      trustContext?: unknown;
      setVoiceCallControlPrompt: (prompt: string | null) => void;
      setTrustContext: (ctx: unknown) => void;
    };
    conv.setVoiceCallControlPrompt = (prompt) => {
      conv.voiceCallControlPrompt = prompt ?? undefined;
      events.push(prompt === null ? "prompt:clear" : "prompt:install");
    };
    conv.setTrustContext = (ctx) => {
      conv.trustContext = ctx ?? undefined;
      events.push(
        ctx === null || ctx === undefined ? "trust:clear" : "trust:install",
      );
    };
    fakeConversation = fake.conversation;

    const persistedIds: string[] = [];
    const handle = await startVoiceTurn({
      ...makeTurnOptions(),
      trustContext: { sourceChannel: "phone", trustClass: "guardian" },
      callbacks: {
        persisted_user_message_id: (id) => persistedIds.push(id),
      },
    });
    await flushMicrotasks();

    expect(handle.turnId).toBeString();
    expect(events).toEqual([
      // Initial install, then the losing persist attempt.
      "trust:install",
      "prompt:install",
      "persist",
      // Uninstalled BEFORE the retry wait resolves — the drained turn that
      // holds the lock must not run with the phone prompt or caller trust.
      "trust:clear",
      "prompt:clear",
      "wait:resolved",
      // Re-installed before the successful retry persist.
      "trust:install",
      "prompt:install",
      "persist",
      "client:install",
      // The turn's own finally releases the state again.
      "trust:clear",
      "prompt:clear",
      "client:reset",
    ]);
    expect(fake.persistCount()).toBe(2);
    expect(fake.waitForIdleCalls.length).toBe(1);
    // The retried persist's row id is the one reported to the client.
    expect(persistedIds).toEqual(["msg-2"]);
  });

  test("a busy persist whose retry wait exhausts the budget throws the exact busy error", async () => {
    const fake = makeFakeConversation({
      processing: false,
      // The retry wait times out — the drained turn holds the lock past
      // the remaining budget.
      waitForIdle: async () => false,
      onPersist: () => {
        fake.setProcessingFlag(true);
        throw new Error("Conversation is already processing a message");
      },
    });
    fakeConversation = fake.conversation;

    await expect(startVoiceTurn(makeTurnOptions())).rejects.toThrow(
      "Conversation is already processing a message",
    );
    expect(fake.persistCount()).toBe(1);
    expect(fake.waitForIdleCalls.length).toBe(1);
  });

  test("the busy-persist retry happens at most once", async () => {
    const fake = makeFakeConversation({
      processing: false,
      waitForIdle: async () => true,
      onPersist: () => {
        throw new Error("Conversation is already processing a message");
      },
    });
    fakeConversation = fake.conversation;

    await expect(startVoiceTurn(makeTurnOptions())).rejects.toThrow(
      "Conversation is already processing a message",
    );
    expect(fake.persistCount()).toBe(2);
    expect(fake.waitForIdleCalls.length).toBe(1);
  });

  test("an abort during the busy-persist retry wait throws the turn-aborted error", async () => {
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: false,
      waitForIdle: ({ signal }) =>
        new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      onPersist: () => {
        throw new Error("Conversation is already processing a message");
      },
    });
    fakeConversation = fake.conversation;

    const turnPromise = startVoiceTurn(makeTurnOptions(controller.signal));
    await flushMicrotasks();
    controller.abort();
    await expect(turnPromise).rejects.toThrow(
      "Turn aborted while waiting for conversation",
    );
    expect(fake.persistCount()).toBe(1);
  });
});

describe("startVoiceTurn race-loss state restore", () => {
  // A busy persist means a concurrent turn (the lock winner) is running with
  // per-turn state it installed. Every race-loss path must put the winner's
  // values back — clearing to defaults would null the winner's trust context
  // and capabilities mid-run and reset its assistantId to "self".

  test("losing the persist race restores the winner's values for the duration of the retry wait", async () => {
    const winnerState = makeWinnerState();
    const statesDuringWait: FakeTurnState[] = [];
    const statesAtRetryPersist: FakeTurnState[] = [];
    const fake = makeFakeConversation({
      processing: false,
      waitForIdle: async () => {
        statesDuringWait.push(readState());
        fake.setProcessingFlag(false);
        return true;
      },
      onPersist: (attempt) => {
        if (attempt === 1) {
          fake.setProcessingFlag(true);
          throw new Error("Conversation is already processing a message");
        }
        statesAtRetryPersist.push(readState());
      },
    });
    const readState = wireTurnState(fake.conversation, winnerState);
    fakeConversation = fake.conversation;

    await startVoiceTurn({
      ...makeTurnOptions(undefined, "conv-race-loss-restore"),
      callSessionId: "session-voice-loser",
      trustContext: { sourceChannel: "phone", trustClass: "guardian" },
    });

    // During the retry wait the conversation reads back the WINNER's values
    // — including the turn channel/interface contexts — not nulls/defaults.
    expect(statesDuringWait).toEqual([winnerState]);
    // After the wait and the successful retry, the voice turn's values are
    // installed again.
    expect(statesAtRetryPersist.length).toBe(1);
    const retryState = statesAtRetryPersist[0]!;
    expect(retryState.assistantId).toBe("self");
    expect(retryState.callSessionId).toBe("session-voice-loser");
    expect(retryState.trustContext).toEqual({
      sourceChannel: "phone",
      trustClass: "guardian",
    });
    expect(retryState.turnChannelContext).toEqual({
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
    });
    expect(retryState.turnInterfaceContext).toEqual({
      userMessageInterface: "phone",
      assistantMessageInterface: "phone",
    });
    expect(retryState.voiceCallControlPrompt).toContain("voice_call_control");
  });

  test("a busy persist whose retry wait exhausts the budget leaves the winner's values in place", async () => {
    const winnerState = makeWinnerState();
    const fake = makeFakeConversation({
      processing: false,
      waitForIdle: async () => false,
      onPersist: () => {
        fake.setProcessingFlag(true);
        throw new Error("Conversation is already processing a message");
      },
    });
    const readState = wireTurnState(fake.conversation, winnerState);
    fakeConversation = fake.conversation;

    await expect(
      startVoiceTurn({
        ...makeTurnOptions(undefined, "conv-race-budget-restore"),
        callSessionId: "session-voice-loser",
        trustContext: { sourceChannel: "phone", trustClass: "guardian" },
      }),
    ).rejects.toThrow("Conversation is already processing a message");
    // The voice turn never ran, so it leaves zero trace: the conversation is
    // exactly as the winner had it, not reset to defaults.
    expect(readState()).toEqual(winnerState);
  });

  test("a retry persist that stays busy leaves the winner's values in place", async () => {
    const winnerState = makeWinnerState();
    const fake = makeFakeConversation({
      processing: false,
      waitForIdle: async () => true,
      onPersist: () => {
        throw new Error("Conversation is already processing a message");
      },
    });
    const readState = wireTurnState(fake.conversation, winnerState);
    fakeConversation = fake.conversation;

    await expect(
      startVoiceTurn({
        ...makeTurnOptions(undefined, "conv-race-retry-busy-restore"),
        trustContext: { sourceChannel: "phone", trustClass: "guardian" },
      }),
    ).rejects.toThrow("Conversation is already processing a message");
    expect(fake.persistCount()).toBe(2);
    expect(readState()).toEqual(winnerState);
  });

  test("an abort during the busy-persist retry wait leaves the winner's values in place", async () => {
    const winnerState = makeWinnerState();
    const controller = new AbortController();
    const fake = makeFakeConversation({
      processing: false,
      waitForIdle: ({ signal }) =>
        new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      onPersist: () => {
        fake.setProcessingFlag(true);
        throw new Error("Conversation is already processing a message");
      },
    });
    const readState = wireTurnState(fake.conversation, winnerState);
    fakeConversation = fake.conversation;

    const turnPromise = startVoiceTurn({
      ...makeTurnOptions(controller.signal, "conv-race-abort-restore"),
      trustContext: { sourceChannel: "phone", trustClass: "guardian" },
    });
    await flushMicrotasks();
    controller.abort();
    await expect(turnPromise).rejects.toThrow(
      "Turn aborted while waiting for conversation",
    );
    expect(readState()).toEqual(winnerState);
  });

  test("a busy persist with the wait budget already exhausted still restores the winner", async () => {
    // The wait loop can consume the entire budget before the persist's busy
    // throw; the busy failure must still route to restore (a live winner
    // holds the lock), not to cleanup's reset-to-defaults.
    const winnerState = makeWinnerState();
    const fake = makeFakeConversation({
      processing: true,
      waitForIdle: async () => {
        // The lock releases, but only after the full wait budget elapsed.
        setSystemTime(new Date(Date.now() + 100 + ABORT_WATCHDOG_MS + 1001));
        fake.setProcessingFlag(false);
        return true;
      },
      onPersist: () => {
        fake.setProcessingFlag(true);
        throw new Error("Conversation is already processing a message");
      },
    });
    const readState = wireTurnState(fake.conversation, winnerState);
    fakeConversation = fake.conversation;

    try {
      await expect(
        startVoiceTurn({
          ...makeTurnOptions(undefined, "conv-race-zero-budget-restore"),
          trustContext: { sourceChannel: "phone", trustClass: "guardian" },
        }),
      ).rejects.toThrow("Conversation is already processing a message");
    } finally {
      setSystemTime();
    }
    expect(fake.persistCount()).toBe(1);
    expect(readState()).toEqual(winnerState);
  });

  test("fields the winner overwrote mid-persist are left with the winner's values", async () => {
    // persistUserMessage yields before its busy check, so the winner can
    // install its own values AFTER this turn's install. The restore must be
    // per-field: revert only fields still holding this turn's values.
    const winnerState = makeWinnerState();
    const overwrittenTrust = {
      sourceChannel: "web",
      trustClass: "owner-overwrite",
    };
    const overwrittenChannelContext = {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    };
    const statesDuringWait: FakeTurnState[] = [];
    const fake = makeFakeConversation({
      processing: false,
      waitForIdle: async () => {
        statesDuringWait.push(readState());
        fake.setProcessingFlag(false);
        return true;
      },
      onPersist: (attempt) => {
        if (attempt === 1) {
          // The winner installs its own trust + turn channel context during
          // the persist await, then the busy throw lands here.
          const conv = fake.conversation as unknown as {
            setTrustContext: (ctx: unknown) => void;
            setTurnChannelContext: (ctx: unknown) => void;
          };
          conv.setTrustContext(overwrittenTrust);
          conv.setTurnChannelContext(overwrittenChannelContext);
          fake.setProcessingFlag(true);
          throw new Error("Conversation is already processing a message");
        }
      },
    });
    const readState = wireTurnState(fake.conversation, winnerState);
    fakeConversation = fake.conversation;

    await startVoiceTurn({
      ...makeTurnOptions(undefined, "conv-race-partial-overwrite"),
      callSessionId: "session-voice-loser",
      trustContext: { sourceChannel: "phone", trustClass: "guardian" },
    });

    // During the wait: fields the winner overwrote keep the WINNER's values;
    // fields only this turn touched are restored to the pre-install state.
    expect(statesDuringWait.length).toBe(1);
    const waited = statesDuringWait[0]!;
    expect(waited.trustContext).toBe(overwrittenTrust);
    expect(waited.turnChannelContext).toBe(overwrittenChannelContext);
    expect(waited.voiceCallControlPrompt).toBe(
      winnerState.voiceCallControlPrompt,
    );
    expect(waited.channelCapabilities).toBe(winnerState.channelCapabilities);
    expect(waited.callSessionId).toBe(winnerState.callSessionId);
    expect(waited.assistantId).toBe(winnerState.assistantId);
  });
});

describe("startVoiceTurn tool-event forwarding", () => {
  // The agent loop's tool_use_start / tool_result events reach the voice
  // callbacks so the session can track per-turn tool activity. The bridge is
  // the single truncation point for tool results — the raw result can be
  // huge and must never travel further into the voice layer.

  /** Scripts runAgentLoop to emit the given agent-loop events in order. */
  function makeEventEmittingConversation(events: unknown[]) {
    const fake = makeFakeConversation({ processing: false });
    fake.conversation.runAgentLoop = async (...args: unknown[]) => {
      const { onEvent } = args[2] as { onEvent: (msg: unknown) => void };
      for (const event of events) {
        onEvent(event);
      }
    };
    fakeConversation = fake.conversation;
  }

  test("tool_use_start delivers the tool name, toolUseId, and input", async () => {
    makeEventEmittingConversation([
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: { query: "weather" },
        toolUseId: "toolu-1",
      },
    ]);

    const starts: Array<{ toolName: string; detail?: unknown }> = [];
    await startVoiceTurn({
      ...makeTurnOptions(),
      callbacks: {
        tool_use_start: (toolName, detail) => starts.push({ toolName, detail }),
      },
    });
    await flushMicrotasks();

    expect(starts).toEqual([
      {
        toolName: "web_search",
        detail: { toolUseId: "toolu-1", input: { query: "weather" } },
      },
    ]);
  });

  test("tool_result delivers name, id, isError, and a preview truncated to the max preview length", async () => {
    const longResult = "x".repeat(TOOL_RESULT_PREVIEW_MAX_CHARS + 100);
    makeEventEmittingConversation([
      {
        type: "tool_result",
        toolName: "web_search",
        result: longResult,
        isError: true,
        toolUseId: "toolu-1",
      },
    ]);

    const results: unknown[] = [];
    await startVoiceTurn({
      ...makeTurnOptions(),
      callbacks: {
        tool_result: (event) => results.push(event),
      },
    });
    await flushMicrotasks();

    // The shared `truncate` util caps at the max preview length including
    // its "..." truncation marker.
    const truncationMarker = "...";
    const expectedPreview =
      "x".repeat(TOOL_RESULT_PREVIEW_MAX_CHARS - truncationMarker.length) +
      truncationMarker;
    expect(expectedPreview).toHaveLength(TOOL_RESULT_PREVIEW_MAX_CHARS);
    expect(results).toEqual([
      {
        toolName: "web_search",
        toolUseId: "toolu-1",
        isError: true,
        resultPreview: expectedPreview,
      },
    ]);
  });

  test("tool_result forwards prod-shaped local-tool payloads, including one without a toolUseId", async () => {
    // Local tools emit tool_result with the tool's real name; toolUseId is
    // optional on the wire, so the name must survive the bridge for the
    // session's name-fallback correlation.
    makeEventEmittingConversation([
      {
        type: "tool_result",
        toolName: "bash",
        result: "total 4",
        isError: false,
        toolUseId: "toolu-1",
      },
      {
        type: "tool_result",
        toolName: "file_read",
        result: "file contents",
      },
    ]);

    const results: unknown[] = [];
    await startVoiceTurn({
      ...makeTurnOptions(),
      callbacks: {
        tool_result: (event) => results.push(event),
      },
    });
    await flushMicrotasks();

    expect(results).toEqual([
      {
        toolName: "bash",
        toolUseId: "toolu-1",
        isError: false,
        resultPreview: "total 4",
      },
      {
        toolName: "file_read",
        toolUseId: undefined,
        isError: undefined,
        resultPreview: "file contents",
      },
    ]);
  });

  test("a callbacks object without the tool-event members doesn't throw", async () => {
    makeEventEmittingConversation([
      {
        type: "tool_use_start",
        toolName: "web_search",
        input: {},
        toolUseId: "toolu-1",
      },
      {
        type: "tool_result",
        toolName: "web_search",
        result: "ok",
        toolUseId: "toolu-1",
      },
    ]);

    const handle = await startVoiceTurn({
      ...makeTurnOptions(),
      callbacks: {},
    });
    await flushMicrotasks();

    expect(handle.turnId).toBeString();
  });
});

describe("front-door leg tool suppression", () => {
  test("tools are disabled for exactly the front-door loop's duration", async () => {
    let depthDuringLoop = -1;
    const fake = makeFakeConversation({
      processing: false,
      runAgentLoop: async () => {
        depthDuringLoop = fake.conversation.toolsDisabledDepth;
      },
    });
    fakeConversation = fake.conversation;

    await startVoiceTurn({
      ...makeTurnOptions(undefined, "conv-front-door-tools"),
      routingLeg: "front-door",
    });
    await flushMicrotasks();

    // Suppressed while the loop ran; the finally released it.
    expect(depthDuringLoop).toBe(1);
    expect(fake.conversation.toolsDisabledDepth).toBe(0);
  });

  test("non-routed and escalated legs leave tools enabled", async () => {
    for (const routingLeg of [undefined, "escalated" as const]) {
      let depthDuringLoop = -1;
      const fake = makeFakeConversation({
        processing: false,
        runAgentLoop: async () => {
          depthDuringLoop = fake.conversation.toolsDisabledDepth;
        },
      });
      fakeConversation = fake.conversation;

      await startVoiceTurn({
        ...makeTurnOptions(undefined, "conv-tools-untouched"),
        ...(routingLeg ? { routingLeg } : {}),
      });
      await flushMicrotasks();

      expect(depthDuringLoop).toBe(0);
      expect(fake.conversation.toolsDisabledDepth).toBe(0);
    }
  });
});

describe("cutFrontDoorContentAtVerdict", () => {
  test("null when the content carries no verdict token (committed answer)", () => {
    expect(
      cutFrontDoorContentAtVerdict([{ type: "text", text: "It is Tuesday." }]),
    ).toBeNull();
  });

  test("an escalated leg reduces to its capped spoken bridge", () => {
    const cut = cutFrontDoorContentAtVerdict([
      {
        type: "text",
        text: "[1] Let me check your calendar. weak answer past the cap",
      },
    ]);
    expect(cut?.blocks).toEqual([
      { type: "text", text: "Let me check your calendar." },
    ]);
    expect(cut?.spokenText).toBe("Let me check your calendar.");
  });

  test("a verdict split across blocks is still recognized from the joined text", () => {
    const cut = cutFrontDoorContentAtVerdict([
      { type: "text", text: "[1" },
      { type: "text", text: "] One moment. " },
      { type: "text", text: "trailing weak text in its own block" },
    ]);
    expect(cut?.blocks).toEqual([{ type: "text", text: "One moment." }]);
    expect(cut?.spokenText).toBe("One moment.");
  });

  test("a bare escalate verdict yields empty spoken text (delete-the-row signal)", () => {
    const cut = cutFrontDoorContentAtVerdict([{ type: "text", text: "[1]" }]);
    expect(cut?.blocks).toEqual([]);
    expect(cut?.spokenText).toBe("");
  });

  test("stray verdict tokens inside an answer are stripped, not treated as escalation", () => {
    const cut = cutFrontDoorContentAtVerdict([
      { type: "text", text: "It is Tuesday [0] indeed." },
    ]);
    expect(cut?.blocks).toEqual([
      { type: "text", text: "It is Tuesday  indeed." },
    ]);
    expect(cut?.spokenText).toBe("It is Tuesday  indeed.");
  });
});

/**
 * The front-door leg's raw stream is a control plane: its leading tokens are
 * the routing verdict, not speech. The hub broadcast (web / passive devices)
 * must never carry those tokens, and must still carry every word of real
 * assistant content: an over-broad filter would leave the shared transcript
 * silent or truncated, which is worse than the leak it fixes.
 */
describe("front-door hub stream gate", () => {
  beforeEach(resetCrudLog);

  /**
   * Conversation whose scripted agent loop announces a reserved row, streams
   * `deltas` in order, then ends the leg with `finalEvent`.
   */
  function makeStreamingConversation(
    deltas: string[],
    finalEvent:
      | "message_complete"
      | "generation_cancelled" = "message_complete",
  ): void {
    const fake = makeFakeConversation({ processing: false });
    fake.conversation.runAgentLoop = async (...args: unknown[]) => {
      const { onEvent } = args[2] as { onEvent: (msg: unknown) => void };
      onEvent({
        type: "assistant_turn_start",
        messageId: "assistant-row-1",
        conversationId: "conv-voice-bridge-test",
      });
      for (const text of deltas) {
        onEvent({
          type: "assistant_text_delta",
          text,
          messageId: "assistant-row-1",
          conversationId: "conv-voice-bridge-test",
        });
      }
      onEvent({
        type: finalEvent,
        ...(finalEvent === "message_complete"
          ? { messageId: "assistant-row-1" }
          : {}),
        conversationId: "conv-voice-bridge-test",
      });
    };
    fakeConversation = fake.conversation;
  }

  /** The text of every `assistant_text_delta` `turn` publishes to the hub. */
  async function collectBroadcastText(
    turn: () => Promise<unknown>,
  ): Promise<string[]> {
    const texts: string[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: { conversationId: "conv-voice-bridge-test" },
      callback: (event) => {
        const msg = event.message as { type: string; text?: string };
        if (msg.type === "assistant_text_delta") {
          texts.push(msg.text ?? "");
        }
      },
    });
    try {
      await turn();
      // The hub publishes off a promise chain, so every broadcast costs a
      // few microtask hops before it reaches a subscriber.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    } finally {
      subscription.dispose();
    }
    return texts;
  }

  test("an escalating leg broadcasts only the capped bridge, never the verdict token", async () => {
    makeStreamingConversation([
      "[1]",
      " Let me check your calendar.",
      " weak answer past the cap",
    ]);

    const texts = await collectBroadcastText(() =>
      startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" }),
    );

    expect(texts).toEqual(["Let me check your calendar."]);
    expect(texts.join("")).not.toContain(ESCALATE_VERDICT_TOKEN);
  });

  test("a front-door answer reaches the hub in full", async () => {
    makeStreamingConversation(["It is ", "Tuesday", ", and it is sunny."]);

    const texts = await collectBroadcastText(() =>
      startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" }),
    );

    expect(texts.join("")).toBe("It is Tuesday, and it is sunny.");
  });

  test("an answer that merely opens with a bracket is released in full", async () => {
    // "[" alone could still become the escalate token, so the gate holds it;
    // the next delta disproves the token and the whole prefix must come out.
    makeStreamingConversation(["[", "A] is the option to pick."]);

    const texts = await collectBroadcastText(() =>
      startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" }),
    );

    expect(texts.join("")).toBe("[A] is the option to pick.");
  });

  test("a hold verdict broadcasts nothing", async () => {
    makeStreamingConversation([HOLD_VERDICT_TOKEN]);

    const texts = await collectBroadcastText(() =>
      startVoiceTurn({
        ...makeTurnOptions(),
        routingLeg: "front-door",
        unifiedVerdict: true,
      }),
    );

    expect(texts).toEqual([]);
  });

  test("a leg that completes mid-bridge broadcasts what it handed off with", async () => {
    makeStreamingConversation(["[1] Let me check"]);

    const texts = await collectBroadcastText(() =>
      startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" }),
    );

    expect(texts).toEqual(["Let me check"]);
  });

  test("a leg cancelled mid-bridge never hands off, so it broadcasts nothing", async () => {
    makeStreamingConversation(["[1] Let me check"], "generation_cancelled");

    const texts = await collectBroadcastText(() =>
      startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" }),
    );

    expect(texts).toEqual([]);
  });

  test("the escalated continuation streams to the hub untouched", async () => {
    // The leg that produces the real answer is never gated: its deltas are
    // assistant speech from the first token.
    makeStreamingConversation(["Your next meeting ", "is at four."]);

    const texts = await collectBroadcastText(() =>
      startVoiceTurn({ ...makeTurnOptions(), routingLeg: "escalated" }),
    );

    expect(texts).toEqual(["Your next meeting ", "is at four."]);
  });

  test("an un-routed voice leg streams to the hub untouched", async () => {
    makeStreamingConversation(["[1] not a verdict here"]);

    const texts = await collectBroadcastText(() =>
      startVoiceTurn(makeTurnOptions()),
    );

    expect(texts).toEqual(["[1] not a verdict here"]);
  });
});

describe("transcript hygiene (teardown pass)", () => {
  beforeEach(resetCrudLog);

  function makeRow(text: string) {
    return {
      id: "assistant-row-1",
      conversationId: "conv-voice-bridge-test",
      role: "assistant",
      content: [{ type: "text", text }],
      createdAt: 0,
      metadata: null,
      clientMessageId: null,
      finalized: 1,
    };
  }

  /**
   * Conversation whose scripted agent loop announces a reserved assistant
   * row via `assistant_turn_start` — the id the teardown hygiene pass
   * targets. With `holdLoopOpen` the loop stays in flight until released,
   * so a discard can land mid-turn.
   */
  function makeReservedRowConversation(opts?: { holdLoopOpen?: boolean }) {
    let release: () => void = () => {};
    const events: string[] = [];
    const fake = makeFakeConversation({ processing: false, events });
    fake.conversation.runAgentLoop = async (...args: unknown[]) => {
      const { onEvent } = args[2] as { onEvent: (msg: unknown) => void };
      onEvent({
        type: "assistant_turn_start",
        messageId: "assistant-row-1",
        conversationId: "conv-voice-bridge-test",
      });
      if (opts?.holdLoopOpen) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    fakeConversation = fake.conversation;
    return { events, releaseLoop: () => release() };
  }

  test("an escalated leg's row is cut to the spoken bridge and history reloads", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () =>
      makeRow("[1] Let me check your calendar. weak answer past the cap");

    await startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" });
    await flushMicrotasks();

    expect(crudLog.updates).toEqual([
      {
        messageId: "assistant-row-1",
        content: JSON.stringify([
          { type: "text", text: "Let me check your calendar." },
        ]),
      },
    ]);
    expect(crudLog.deletes).toHaveLength(0);
    // The escalated leg waits on this turn's teardown, so the reload below
    // is what guarantees the quality model never sees the marker text.
    expect(events).toContain("loadFromDb");
  });

  test("a bare-verdict row (canned fallback was the audio) is deleted", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("[1]");

    await startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" });
    await flushMicrotasks();

    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toEqual(["assistant-row-1"]);
    expect(events).toContain("loadFromDb");
  });

  test("a committed front-door answer (no verdict token) is left untouched", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("It is Tuesday.");

    await startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" });
    await flushMicrotasks();

    expect(crudLog.reads).toEqual(["assistant-row-1"]);
    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toHaveLength(0);
    expect(events).not.toContain("loadFromDb");
  });

  test("a front-door answer ending with the minimize marker has the marker stripped", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("Here we go, watch the overlay. [-1]");

    await startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" });
    await flushMicrotasks();

    expect(crudLog.updates).toEqual([
      {
        messageId: "assistant-row-1",
        content: JSON.stringify([
          { type: "text", text: "Here we go, watch the overlay." },
        ]),
      },
    ]);
    expect(crudLog.deletes).toHaveLength(0);
    expect(events).toContain("loadFromDb");
  });

  test("a marker-only front-door answer row is deleted", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("[-1]");

    await startVoiceTurn({ ...makeTurnOptions(), routingLeg: "front-door" });
    await flushMicrotasks();

    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toEqual(["assistant-row-1"]);
    expect(events).toContain("loadFromDb");
  });

  test("a non-routed leg leaves verdict-token content untouched (verdict cutting is front-door-only)", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("[1] Anything at all");

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.reads).toEqual(["assistant-row-1"]);
    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toHaveLength(0);
    expect(events).not.toContain("loadFromDb");
  });

  test("a main-leg row containing the minimize marker persists with the marker stripped", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("Done, take a look [-1]");

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.updates).toEqual([
      {
        messageId: "assistant-row-1",
        content: JSON.stringify([{ type: "text", text: "Done, take a look" }]),
      },
    ]);
    expect(crudLog.deletes).toHaveLength(0);
    // The clean row must reach in-memory history and sync consumers.
    expect(events).toContain("loadFromDb");
  });

  test("a mid-text [-1] (content, not command) leaves the row untouched", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () =>
      makeRow("The array [-1] sorts first, then the rest.");

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toHaveLength(0);
    expect(events).not.toContain("loadFromDb");
  });

  test("a marker-only main-leg row is deleted, not persisted as an empty bubble", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("[-1]");

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toEqual(["assistant-row-1"]);
    expect(events).toContain("loadFromDb");
  });

  test("a terminal marker split across text blocks is stripped whole", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => ({
      ...makeRow(""),
      content: [
        { type: "text", text: "Done, take a look [-" },
        { type: "text", text: "1]" },
      ],
    });

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.updates).toEqual([
      {
        messageId: "assistant-row-1",
        content: JSON.stringify([{ type: "text", text: "Done, take a look" }]),
      },
    ]);
    expect(crudLog.deletes).toHaveLength(0);
    expect(events).toContain("loadFromDb");
  });

  test("a marker-only row split across text blocks is deleted", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => ({
      ...makeRow(""),
      content: [
        { type: "text", text: "[-" },
        { type: "text", text: "1]" },
      ],
    });

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toEqual(["assistant-row-1"]);
    expect(events).toContain("loadFromDb");
  });

  test("a marker-only row with a surviving non-text block is rewritten, never deleted", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => ({
      ...makeRow("[-1]"),
      content: [
        { type: "text", text: "[-1]" },
        { type: "tool_use", id: "tool-1", name: "app_create", input: {} },
      ],
    });

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.deletes).toHaveLength(0);
    expect(crudLog.updates).toEqual([
      {
        messageId: "assistant-row-1",
        content: JSON.stringify([
          { type: "tool_use", id: "tool-1", name: "app_create", input: {} },
        ]),
      },
    ]);
    expect(events).toContain("loadFromDb");
  });

  test("a main-leg row without the minimize marker is never rewritten", async () => {
    const { events } = makeReservedRowConversation();
    getMessageByIdImpl = () => makeRow("Done, take a look.");

    await startVoiceTurn(makeTurnOptions());
    await flushMicrotasks();

    expect(crudLog.reads).toEqual(["assistant-row-1"]);
    expect(crudLog.updates).toHaveLength(0);
    expect(crudLog.deletes).toHaveLength(0);
    expect(events).not.toContain("loadFromDb");
  });

  test("a discarded speculative leg deletes its reserved assistant row at teardown", async () => {
    const { releaseLoop } = makeReservedRowConversation({
      holdLoopOpen: true,
    });

    const handle = await startVoiceTurn({
      ...makeTurnOptions(),
      routingLeg: "front-door",
      unifiedVerdict: true,
    });
    await flushMicrotasks();
    await handle.discard?.();

    // The discard rolls back the user row at once; the reserved assistant
    // row is only safe to remove after the loop settles (the stranded fold
    // would otherwise re-finalize it), so it goes at teardown.
    expect(crudLog.deletes).toContain("msg-1");
    expect(crudLog.deletes).not.toContain("assistant-row-1");

    releaseLoop();
    await flushMicrotasks();

    expect(crudLog.deletes).toContain("assistant-row-1");
  });
});
