/**
 * End-to-end integration test for the proactive-chat pipeline.
 *
 * What this test exercises, in order, for a single transcript chunk:
 *
 *   1. Real {@link MeetChatOpportunityDetector}. A Tier 1 regex match fires
 *      on an assistant-name-mentioning question ("Hey AI, what was the
 *      action item…?").
 *   2. Mocked Tier 2 LLM (`ChatOpportunityLLMAsk`). Scripted per-scenario
 *      to return either `shouldRespond: true` or `false`.
 *   3. Real {@link wakeAgentForOpportunity}. Resolves the wake target via
 *      the `resolveTarget` dep injected per test.
 *   4. Mocked main agent loop. Either emits a `tool_use` block for
 *      `meet_send_chat` (happy path) or produces no tool calls (decline).
 *      The `tool_use` path synchronously invokes the real
 *      `MeetSessionManager.sendChat(meetingId, text)` — exactly what a
 *      real agent would do on this tool call.
 *   5. Real {@link MeetSessionManager.sendChat}. Hits a real HTTP server
 *      (see below) over `fetch()`.
 *   6. Fake bot HTTP server (`Bun.serve` on loopback). Records every
 *      `/send_chat` it receives; reused from the `chat-send-e2e.test.ts`
 *      pattern.
 *
 * What it does NOT touch: Docker, real Meet, real LLM provider, real
 * conversation DB (each test's `WakeTarget.persistTailMessage` records
 * to an in-memory array instead).
 *
 * Wiring choice: **Option B** from the plan — detector + wake + session
 * manager wired directly, bypassing `MeetSessionManager.join()`'s heavy
 * lifting (container spawn, audio ingest, storage writer) because none of
 * that is on the proactive-chat critical path. The happy-path goal of
 * `<100ms` is easy to hit when we don't stand up a full session.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { MeetBotEvent } from "../../contracts/index.js";

import type { AgentEvent } from "../../../../assistant/src/agent/loop.js";
import type { Message } from "../../../../assistant/src/providers/types.js";

// `agent-wake.ts` delegates persistence to `WakeTarget.persistTailMessage`
// (see Gap 2 in the round-2 fixes). The daemon adapter is responsible for
// building channel/interface metadata and calling `addMessage` —
// out-of-scope for this integration test. We supply a `persistTailMessage`
// implementation in each test's `WakeTarget` that records the call so we
// can assert wake-tail persistence happened, without booting a real DB.
const persistedMessages: Array<{
  conversationId: string;
  role: string;
  content: string;
}> = [];

function recordPersistedMessage(
  conversationId: string,
): (
  msg: import("../../../../assistant/src/providers/types.js").Message,
) => Promise<void> {
  return async (msg) => {
    persistedMessages.push({
      conversationId,
      role: msg.role,
      content: JSON.stringify(msg.content),
    });
  };
}

import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
  type WakeTarget,
} from "../../../../assistant/src/runtime/agent-wake.js";
import {
  type ChatOpportunityDecision,
  type ChatOpportunityEvent,
  MeetChatOpportunityDetector,
  type ProactiveChatConfig,
  type VoiceModeConfig,
} from "../chat-opportunity-detector.js";
import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";
import { meetEventDispatcher } from "../event-publisher.js";
import { __resetMeetSessionEventRouterForTests } from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  MEET_BOT_INTERNAL_PORT,
  type MeetAudioIngestLike,
} from "../session-manager.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
}

interface FakeBotServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  stop: () => Promise<void>;
}

/**
 * Minimal `Bun.serve` stand-in for the meet-bot's control API. Always
 * returns `200 { sent: true }` on `/send_chat`. Records every request so
 * tests can assert that a chat actually reached the bot.
 */
function startFakeBot(): FakeBotServer {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = await req.text().catch(() => "");
      requests.push({
        method: req.method,
        url: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body,
      });
      return new Response(JSON.stringify({ sent: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const port = server.port;
  if (port === undefined) {
    throw new Error("fake bot server failed to bind a port");
  }
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** Fake audio ingest — the session manager never touches it after start. */
function makeFakeAudioIngest(): MeetAudioIngestLike {
  return {
    start: async () => ({ port: 42173, ready: Promise.resolve() }),
    stop: async () => {},
    subscribePcm: () => () => {},
  };
}

/** Mock Docker runner whose `run()` pins the session to the fake bot's host port. */
function makeMockRunnerPointingAt(fakeBot: FakeBotServer) {
  const runResult = {
    containerId: "container-proactive-e2e",
    boundPorts: [
      {
        protocol: "tcp" as const,
        containerPort: MEET_BOT_INTERNAL_PORT,
        hostIp: "127.0.0.1",
        hostPort: fakeBot.port,
      },
    ],
  };
  return {
    run: mock(async () => runResult),
    stop: mock(async () => {}),
    remove: mock(async () => {}),
    inspect: mock(async () => ({ Id: runResult.containerId })),
    logs: mock(async () => ""),
  };
}

/**
 * Fake dispatcher — the detector subscribes via `subs.subscribe`, and the
 * test drives transcript / chat events via `dispatch`. Isolated per-test
 * so scenarios cannot leak subscribers into each other.
 */
function makeFakeDispatcher(): {
  subscribe: (
    meetingId: string,
    cb: MeetEventSubscriber,
  ) => MeetEventUnsubscribe;
  dispatch: (meetingId: string, event: MeetBotEvent) => void;
} {
  const subs = new Map<string, Set<MeetEventSubscriber>>();
  return {
    subscribe(meetingId, cb) {
      let set = subs.get(meetingId);
      if (!set) {
        set = new Set();
        subs.set(meetingId, set);
      }
      set.add(cb);
      return () => {
        const existing = subs.get(meetingId);
        if (!existing) return;
        existing.delete(cb);
        if (existing.size === 0) subs.delete(meetingId);
      };
    },
    dispatch(meetingId, event) {
      const set = subs.get(meetingId);
      if (!set) return;
      for (const cb of Array.from(set)) cb(event);
    },
  };
}

/** Injectable clock used by the cooldown scenario to advance time. */
function makeClock(initial: number): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = initial;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

function transcriptChunk(
  meetingId: string,
  text: string,
  timestamp = "2024-01-01T00:00:00.000Z",
): MeetBotEvent {
  return {
    type: "transcript.chunk",
    meetingId,
    timestamp,
    isFinal: true,
    text,
    speakerLabel: "Alice",
  };
}

function defaultProactiveChatConfig(
  overrides: Partial<ProactiveChatConfig> = {},
): ProactiveChatConfig {
  return {
    enabled: true,
    // Keyword list doesn't matter for "Hey AI, …?" — the detector's built-in
    // `(hey|hi|ok|so),? <name>[,.]? … ?` pattern already handles it.
    detectorKeywords: [],
    // Very short debounce so successive scenarios within the same describe
    // block don't bleed into each other. The cooldown-scenario test
    // overrides `escalationCooldownSec` for its own assertions.
    tier2DebounceMs: 0,
    escalationCooldownSec: 30,
    tier2MaxTranscriptSec: 30,
    ...overrides,
  };
}

function defaultVoiceModeConfig(
  overrides: Partial<VoiceModeConfig> = {},
): VoiceModeConfig {
  // Disable voice mode by default in the proactive-chat e2e suite: these
  // scenarios exercise the Tier 1 + Tier 2 path explicitly and treat
  // "Hey AI, …?" as a Tier 1 trigger. Voice mode's 1:1 branch would
  // otherwise capture the same events before Tier 1 ever ran.
  return {
    enabled: false,
    eouDebounceMs: 800,
    ...overrides,
  };
}

/**
 * Wait a handful of microtasks so async chains (detector → Tier 2 LLM →
 * wake → tool → HTTP fetch) can settle before assertions. Each scenario
 * runs one complete pipeline; four microtasks plus a zero-delay tick is
 * enough for the happy path to clear in <100ms on mocked components.
 */
async function flushPipeline(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Shared per-test state
// ---------------------------------------------------------------------------

let workspaceDir: string;
let fakeBot: FakeBotServer;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "proactive-chat-e2e-"));
  __resetMeetSessionEventRouterForTests();
  __resetWakeChainForTests();
  meetEventDispatcher._resetForTests();
  persistedMessages.length = 0;
  fakeBot = startFakeBot();
});

afterEach(async () => {
  await fakeBot.stop();
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

/** Hint the detector passes to the wake in the happy path. */
const TIER2_POSITIVE_REASON =
  "user directly addressed the assistant with a question";

/**
 * Build a mocked agent loop whose `run()` emits the scripted assistant
 * content (tool_use or text/empty) and — for the happy path — actually
 * invokes `MeetSessionManager.sendChat` so the HTTP call hits the fake
 * bot. The mocked agent faithfully models what a real agent would do
 * when the wake hands it a transcript-derived hint.
 */
function makeMockAgentLoop(options: {
  /** The tool_use block the LLM "emits". Set to null to simulate no tool calls. */
  toolUse: { id: string; name: string; input: Record<string, unknown> } | null;
  /**
   * If set, will be invoked synchronously inside `run()` to simulate the
   * tool executor handling `meet_send_chat`. The e2e test wires this to
   * the real `MeetSessionManager.sendChat(meetingId, text)`.
   */
  onToolUse?: (toolUse: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }) => Promise<void> | void;
}): { runCalls: number; loop: WakeTarget["agentLoop"] } {
  let runCalls = 0;
  const loop: WakeTarget["agentLoop"] = {
    run: async (
      input: Message[],
      onEvent: (event: AgentEvent) => void | Promise<void>,
      _signal?: AbortSignal,
      _requestId?: string,
    ) => {
      runCalls++;
      const next = [...input];
      if (options.toolUse) {
        const assistant: Message = {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: options.toolUse.id,
              name: options.toolUse.name,
              input: options.toolUse.input,
            },
          ],
        };
        next.push(assistant);
        await onEvent({ type: "message_complete", message: assistant });
        if (options.onToolUse) {
          await options.onToolUse(options.toolUse);
        }
        return next;
      }
      // Decline — no tool calls, no visible text.
      const empty: Message = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      };
      next.push(empty);
      await onEvent({ type: "message_complete", message: empty });
      return next;
    },
  };
  return {
    get runCalls() {
      return runCalls;
    },
    loop,
  };
}

/**
 * Stand up a live `MeetSessionManager` with a single active session
 * pointed at the fake bot. Returns the session + manager so tests can
 * exercise `sendChat` via a real HTTP call. This is a lighter-weight
 * alternative to the full join/leave dance — we only need `sendChat` to
 * work against the fake bot, not the rest of the container lifecycle.
 */
async function standUpSessionManagerPointedAt(
  fakeBot: FakeBotServer,
  meetingId: string,
): Promise<{
  manager: ReturnType<typeof _createMeetSessionManagerForTests>;
  leave: () => Promise<void>;
}> {
  const runner = makeMockRunnerPointingAt(fakeBot);
  const manager = _createMeetSessionManagerForTests({
    dockerRunnerFactory: () => runner,
    getProviderKey: async () => "",
    getWorkspaceDir: () => workspaceDir,
    botLeaveFetch: async () => {},
    audioIngestFactory: makeFakeAudioIngest,
    // Silence the default chat-opportunity detector factory — we
    // construct our own detector directly in this test.
    chatOpportunityDetectorFactory: () => ({
      start: () => {},
      dispose: () => {},
      getStats: () => ({
        tier1Hits: 0,
        tier2Calls: 0,
        tier2PositiveCount: 0,
        escalationsFired: 0,
        escalationsSuppressed: 0,
        voiceWakesFired: 0,
      }),
    }),
    wakeAgent: async () => {},
  });
  await manager.join({
    url: "https://meet.google.com/proactive-e2e",
    meetingId,
    conversationId: "conv-proactive-e2e",
  });
  return {
    manager,
    leave: async () => {
      await manager.leave(meetingId, "cleanup");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proactive-chat E2E — Tier 1 hit → Tier 2 confirms → agent wake → meet_send_chat", () => {
  test("happy path — full chain fires and reaches the fake bot in <100ms", async () => {
    const meetingId = "m-proactive-happy";
    const conversationId = "conv-proactive-e2e";
    const dispatcher = makeFakeDispatcher();

    // Bring up a real session manager with an active session pointed at
    // the fake bot so `sendChat` has somewhere to POST.
    const { manager, leave } = await standUpSessionManagerPointedAt(
      fakeBot,
      meetingId,
    );

    try {
      const tier2Llm = mock(
        async (_prompt: string): Promise<ChatOpportunityDecision> => ({
          shouldRespond: true,
          reason: TIER2_POSITIVE_REASON,
        }),
      );

      // Wake target: real conversation surface. The mocked agent loop
      // emits a `meet_send_chat` tool_use block AND runs the side-effect
      // synchronously (as a real tool executor would) against the live
      // session manager.
      const history: Message[] = [];
      const mockAgent = makeMockAgentLoop({
        toolUse: {
          id: "tu-send-chat-1",
          name: "meet_send_chat",
          input: {
            meetingId,
            text: "The action item from the planning sync was to finalize the Q2 roadmap by Friday.",
          },
        },
        onToolUse: async (toolUse) => {
          const input = toolUse.input as { meetingId: string; text: string };
          // This is what the real `meet_send_chat` tool does — call
          // through to the in-process session manager.
          await manager.sendChat(input.meetingId, input.text);
        },
      });
      const target: WakeTarget = {
        conversationId,
        agentLoop: mockAgent.loop,
        getMessages: () => history,
        pushMessage: (msg) => history.push(msg),
        emitAgentEvent: () => {},
        isProcessing: () => false,
        markProcessing: () => {},
        persistTailMessage: recordPersistedMessage(conversationId),
      };

      // Opportunity callback → real agent wake. We await the wake
      // promise so the HTTP fetch completes before we assert below.
      const wakePromises: Array<Promise<void>> = [];
      const detector = new MeetChatOpportunityDetector({
        meetingId,
        assistantDisplayName: "AI",
        config: defaultProactiveChatConfig(),
        voiceConfig: defaultVoiceModeConfig(),
        callDetectorLLM: tier2Llm,
        onOpportunity: ({ reason }: ChatOpportunityEvent) => {
          wakePromises.push(
            wakeAgentForOpportunity(
              {
                conversationId,
                hint: reason,
                source: "meet-chat-opportunity",
              },
              { resolveTarget: async () => target },
            ).then(() => {}),
          );
        },
        subscribe: dispatcher.subscribe,
      });
      detector.start();

      const startedAt = performance.now();
      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Hey AI, what was the action item from the planning sync?",
        ),
      );

      // Let the detector's Tier 2 promise resolve, the wake schedule, and
      // the HTTP round-trip complete.
      await flushPipeline();
      await Promise.all(wakePromises);
      const elapsedMs = performance.now() - startedAt;

      // ---- Assert: full chain fired in order.

      // Tier 2 LLM saw the trigger once.
      expect(tier2Llm).toHaveBeenCalledTimes(1);

      // Detector stats reflect one Tier 1 hit, one Tier 2 call, one fire.
      const stats = detector.getStats();
      expect(stats.tier1Hits).toBe(1);
      expect(stats.tier2Calls).toBe(1);
      expect(stats.tier2PositiveCount).toBe(1);
      expect(stats.escalationsFired).toBe(1);

      // Agent loop was invoked once by the wake.
      expect(mockAgent.runCalls).toBe(1);

      // Fake bot received exactly one chat send with the right shape.
      expect(fakeBot.requests).toHaveLength(1);
      const req = fakeBot.requests[0]!;
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/send_chat");
      expect(req.authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
      const parsed = JSON.parse(req.body) as { type: string; text: string };
      expect(parsed.type).toBe("send_chat");
      expect(parsed.text).toContain("action item");
      expect(parsed.text).toContain("Q2 roadmap");

      // Assistant message was persisted (the wake's tail).
      expect(persistedMessages).toHaveLength(1);
      expect(persistedMessages[0]!.role).toBe("assistant");
      const persistedContent = JSON.parse(persistedMessages[0]!.content) as
        | Array<{ type: string; name?: string }>
        | unknown;
      const blocks = persistedContent as Array<{ type: string; name?: string }>;
      expect(blocks[0]!.type).toBe("tool_use");
      expect(blocks[0]!.name).toBe("meet_send_chat");

      // Performance envelope — tight enough to catch real regressions but
      // loose enough to tolerate slow CI runners. The underlying fake-LLM
      // path completes well under 100ms on developer hardware; 500ms is a
      // 5x headroom that flags genuine perf drift without flaking.
      expect(elapsedMs).toBeLessThan(500);

      detector.dispose();
    } finally {
      await leave();
    }
  });

  test("tier 2 declines — no wake, no tool call, no bot request", async () => {
    const meetingId = "m-proactive-tier2-no";
    const conversationId = "conv-proactive-e2e";
    const dispatcher = makeFakeDispatcher();

    const { leave } = await standUpSessionManagerPointedAt(fakeBot, meetingId);

    try {
      const tier2Llm = mock(
        async (_prompt: string): Promise<ChatOpportunityDecision> => ({
          shouldRespond: false,
          reason: "user was talking to another human, not the assistant",
        }),
      );

      const history: Message[] = [];
      const mockAgent = makeMockAgentLoop({ toolUse: null });
      const target: WakeTarget = {
        conversationId,
        agentLoop: mockAgent.loop,
        getMessages: () => history,
        pushMessage: (msg) => history.push(msg),
        emitAgentEvent: () => {},
        isProcessing: () => false,
        markProcessing: () => {},
        persistTailMessage: recordPersistedMessage(conversationId),
      };

      const wakeSpy = mock(async () => {
        await wakeAgentForOpportunity(
          {
            conversationId,
            hint: "should not fire",
            source: "meet-chat-opportunity",
          },
          { resolveTarget: async () => target },
        );
      });

      const detector = new MeetChatOpportunityDetector({
        meetingId,
        assistantDisplayName: "AI",
        config: defaultProactiveChatConfig(),
        voiceConfig: defaultVoiceModeConfig(),
        callDetectorLLM: tier2Llm,
        onOpportunity: () => {
          void wakeSpy();
        },
        subscribe: dispatcher.subscribe,
      });
      detector.start();

      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Hey AI, what was the action item from the planning sync?",
        ),
      );
      await flushPipeline();

      // Tier 2 was consulted.
      expect(tier2Llm).toHaveBeenCalledTimes(1);

      // But Tier 2 said no → no wake, no tool call, no bot request.
      expect(wakeSpy).toHaveBeenCalledTimes(0);
      expect(mockAgent.runCalls).toBe(0);
      expect(fakeBot.requests).toHaveLength(0);
      expect(persistedMessages).toHaveLength(0);

      const stats = detector.getStats();
      expect(stats.tier1Hits).toBe(1);
      expect(stats.tier2Calls).toBe(1);
      expect(stats.tier2PositiveCount).toBe(0);
      expect(stats.escalationsFired).toBe(0);

      detector.dispose();
    } finally {
      await leave();
    }
  });

  test("agent declines — wake runs, no tool call, no bot request", async () => {
    const meetingId = "m-proactive-agent-no";
    const conversationId = "conv-proactive-e2e";
    const dispatcher = makeFakeDispatcher();

    const { leave } = await standUpSessionManagerPointedAt(fakeBot, meetingId);

    try {
      const tier2Llm = mock(
        async (_prompt: string): Promise<ChatOpportunityDecision> => ({
          shouldRespond: true,
          reason: TIER2_POSITIVE_REASON,
        }),
      );

      // Mocked agent produces no tool calls — the wake returns silently.
      const history: Message[] = [];
      const mockAgent = makeMockAgentLoop({ toolUse: null });
      const target: WakeTarget = {
        conversationId,
        agentLoop: mockAgent.loop,
        getMessages: () => history,
        pushMessage: (msg) => history.push(msg),
        emitAgentEvent: () => {},
        isProcessing: () => false,
        markProcessing: () => {},
        persistTailMessage: recordPersistedMessage(conversationId),
      };

      const wakePromises: Array<
        Promise<{ invoked: boolean; producedToolCalls: boolean }>
      > = [];
      const detector = new MeetChatOpportunityDetector({
        meetingId,
        assistantDisplayName: "AI",
        config: defaultProactiveChatConfig(),
        voiceConfig: defaultVoiceModeConfig(),
        callDetectorLLM: tier2Llm,
        onOpportunity: ({ reason }: ChatOpportunityEvent) => {
          wakePromises.push(
            wakeAgentForOpportunity(
              { conversationId, hint: reason, source: "meet-chat-opportunity" },
              { resolveTarget: async () => target },
            ),
          );
        },
        subscribe: dispatcher.subscribe,
      });
      detector.start();

      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Hey AI, what was the action item from the planning sync?",
        ),
      );

      await flushPipeline();
      const results = await Promise.all(wakePromises);

      // Wake was invoked exactly once.
      expect(results).toHaveLength(1);
      expect(results[0]!.invoked).toBe(true);
      expect(results[0]!.producedToolCalls).toBe(false);
      expect(mockAgent.runCalls).toBe(1);

      // No tool executed → no bot request, no persisted message.
      expect(fakeBot.requests).toHaveLength(0);
      expect(persistedMessages).toHaveLength(0);

      detector.dispose();
    } finally {
      await leave();
    }
  });

  test("cooldown enforcement — two triggers within 30s produce one wake + one bot request", async () => {
    const meetingId = "m-proactive-cooldown";
    const conversationId = "conv-proactive-e2e";
    const dispatcher = makeFakeDispatcher();
    const clock = makeClock(1_000);

    const { manager, leave } = await standUpSessionManagerPointedAt(
      fakeBot,
      meetingId,
    );

    try {
      const tier2Llm = mock(
        async (_prompt: string): Promise<ChatOpportunityDecision> => ({
          shouldRespond: true,
          reason: TIER2_POSITIVE_REASON,
        }),
      );

      const history: Message[] = [];
      let sendChatCallNumber = 0;
      const mockAgent = makeMockAgentLoop({
        toolUse: {
          id: "tu-cooldown",
          name: "meet_send_chat",
          input: {
            meetingId,
            text: "The action item was to finalize the Q2 roadmap.",
          },
        },
        onToolUse: async (toolUse) => {
          sendChatCallNumber++;
          const input = toolUse.input as { meetingId: string; text: string };
          await manager.sendChat(input.meetingId, input.text);
        },
      });

      const target: WakeTarget = {
        conversationId,
        agentLoop: mockAgent.loop,
        getMessages: () => history,
        pushMessage: (msg) => history.push(msg),
        emitAgentEvent: () => {},
        isProcessing: () => false,
        markProcessing: () => {},
        persistTailMessage: recordPersistedMessage(conversationId),
      };

      const wakePromises: Array<Promise<void>> = [];
      const detector = new MeetChatOpportunityDetector({
        meetingId,
        assistantDisplayName: "AI",
        config: defaultProactiveChatConfig({
          // Zero debounce so both triggers reach Tier 2; escalation
          // cooldown is the gate we're actually testing.
          tier2DebounceMs: 0,
          escalationCooldownSec: 30,
        }),
        voiceConfig: defaultVoiceModeConfig(),
        callDetectorLLM: tier2Llm,
        onOpportunity: ({ reason }: ChatOpportunityEvent) => {
          wakePromises.push(
            wakeAgentForOpportunity(
              { conversationId, hint: reason, source: "meet-chat-opportunity" },
              { resolveTarget: async () => target },
            ).then(() => {}),
          );
        },
        subscribe: dispatcher.subscribe,
        now: clock.now,
      });
      detector.start();

      // First trigger — clears Tier 2 → fires wake → tool → bot.
      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Hey AI, what was the action item from the planning sync?",
        ),
      );
      await flushPipeline();

      // Advance 10s (well inside the 30s cooldown) and fire a second
      // trigger that would also clear Tier 2 on its own merits.
      clock.advance(10_000);
      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Hey AI, any update from the planning sync?",
          "2024-01-01T00:00:10.000Z",
        ),
      );
      await flushPipeline();
      await Promise.all(wakePromises);

      // Both triggers hit Tier 1 AND cleared Tier 2, but only the first
      // fired the wake — cooldown suppressed the second.
      const stats = detector.getStats();
      expect(stats.tier1Hits).toBe(2);
      expect(stats.tier2Calls).toBe(2);
      expect(stats.tier2PositiveCount).toBe(2);
      expect(stats.escalationsFired).toBe(1);
      expect(stats.escalationsSuppressed).toBe(1);

      // Downstream: exactly one wake → one tool call → one bot request.
      expect(mockAgent.runCalls).toBe(1);
      expect(sendChatCallNumber).toBe(1);
      expect(fakeBot.requests).toHaveLength(1);

      detector.dispose();
    } finally {
      await leave();
    }
  });

  test("disabled config — zero LLM calls, zero wakes, zero bot requests", async () => {
    const meetingId = "m-proactive-disabled";
    const dispatcher = makeFakeDispatcher();

    const { leave } = await standUpSessionManagerPointedAt(fakeBot, meetingId);

    try {
      // `callDetectorLLM` must not be invoked when `enabled: false`.
      const tier2Llm = mock(
        async (_prompt: string): Promise<ChatOpportunityDecision> => ({
          shouldRespond: true,
          reason: "should never be consulted",
        }),
      );
      const onOpportunity = mock((_event: ChatOpportunityEvent) => {});

      const detector = new MeetChatOpportunityDetector({
        meetingId,
        assistantDisplayName: "AI",
        config: defaultProactiveChatConfig({ enabled: false }),
        voiceConfig: defaultVoiceModeConfig(),
        callDetectorLLM: tier2Llm,
        onOpportunity,
        subscribe: dispatcher.subscribe,
      });
      detector.start();

      // Dispatch several candidate triggers — none should do anything.
      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Hey AI, what was the action item from the planning sync?",
        ),
      );
      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Does anyone know where the design doc lives?",
          "2024-01-01T00:00:01.000Z",
        ),
      );
      dispatcher.dispatch(
        meetingId,
        transcriptChunk(
          meetingId,
          "Can someone share the dashboard link?",
          "2024-01-01T00:00:02.000Z",
        ),
      );
      await flushPipeline();

      expect(tier2Llm).toHaveBeenCalledTimes(0);
      expect(onOpportunity).toHaveBeenCalledTimes(0);
      expect(fakeBot.requests).toHaveLength(0);
      expect(persistedMessages).toHaveLength(0);

      const stats = detector.getStats();
      expect(stats.tier1Hits).toBe(0);
      expect(stats.tier2Calls).toBe(0);
      expect(stats.escalationsFired).toBe(0);

      detector.dispose();
    } finally {
      await leave();
    }
  });
});
