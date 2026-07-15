/**
 * Regression tests for the live reveal-guard priming barrier (LUM-2768).
 *
 * The race: promoting a proven `credentials reveal` starts priming
 * `liveRevealGuardEntries` from the resolved candidates. Resolution is
 * asynchronous (a Promise settled on a microtask), so if the next provider
 * stream's text deltas reached `drainSentinelGuardedText` before priming
 * settled they would guard against an EMPTY entry list and an echoed
 * plaintext would cross SSE raw (the persisted row still redacts, but the
 * live transcript flashed the secret). The dispatcher therefore awaits any
 * in-flight priming before guarding a `text_delta` and before the
 * end-of-message guard flush.
 *
 * The candidate value is the plaintext the reveal ROUTE
 * served (captured on the success record), so resolution no longer re-reads
 * the vault for a proven ref — the store mock below stays untouched on the
 * proven path and is only exercised by the deliberate store-fallback case.
 * The barrier still holds across the priming microtask, which the
 * concurrent-dispatch test asserts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Store mock: reads stay pending until the test releases them ──────────
// Only reached on the store-fallback path (a ref with no proven value); the
// proven path redacts the route-served bytes without touching the store.

type StoreRelease = (value: string | null) => void;
const pendingStoreReads: StoreRelease[] = [];

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: (_key: string) =>
    new Promise<string | null>((resolve) => {
      pendingStoreReads.push(resolve);
    }),
}));

// Feature flag on regardless of config contents.
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (flag: string) =>
    flag === "chat-credential-reveal",
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

// ── Persistence mocks (same shape as tool-preview-lifecycle.test.ts) ─────

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: () => null,
  getMessageById: () => null,
  updateMessageContent: () => {},
  markMessageContentInflight: () => {},
  finalizeMessageContent: () => {},
  provenanceFromTrustContext: () => ({}),
  reserveMessage: () => "reserved-message-id",
  recordConversationPersistedSeq: () => {},
  getConversationPersistedSeq: () => null,
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

mock.module("../plugins/defaults/memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module(
  "../plugins/defaults/memory/memory-v2-activation-log-store.js",
  () => ({
    backfillMemoryV2ActivationMessageId: () => {},
  }),
);

// ── Imports (after mocks) ────────────────────────────────────────────────

import type { AgentEvent } from "../agent/loop.js";
import type { EventHandlerDeps } from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  dispatchAgentEvent,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { _resetStreamStateForTesting } from "../runtime/assistant-stream-state.js";
import {
  recordForChatMint,
  resetForChatMintRegistryForTest,
} from "../runtime/for-chat-mint-registry.js";
import {
  _resetRevealSuccessRegistryForTest,
  recordRevealSuccess,
} from "../runtime/reveal-success-registry.js";
import {
  SYNTHETIC_OPAQUE_CREDENTIAL,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

function toolResults(events: ServerMessage[]): string[] {
  return events
    .filter(
      (e): e is Extract<ServerMessage, { type: "tool_result" }> =>
        (e as { type?: string }).type === "tool_result",
    )
    .map((e) => (typeof e.result === "string" ? e.result : ""));
}

function createMockDeps(collected: ServerMessage[]): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "test-conversation",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: ServerMessage) => {
      collected.push(msg);
    },
    reqId: "test-req-id",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
  } as EventHandlerDeps;
}

function streamedText(events: ServerMessage[]): string {
  return events
    .filter(
      (e): e is Extract<ServerMessage, { type: "assistant_text_delta" }> =>
        (e as { type?: string }).type === "assistant_text_delta",
    )
    .map((e) => e.text)
    .join("");
}

const REVEAL_TOOL_USE = {
  type: "tool_use",
  id: "toolu_reveal",
  name: "bash",
  input: {
    command: "assistant credentials reveal --service openai --field api_key",
  },
} as Extract<AgentEvent, { type: "tool_use" }>;

const REVEAL_TOOL_RESULT = {
  type: "tool_result",
  toolUseId: "toolu_reveal",
  content: "(revealed value printed to stdout)",
  isError: false,
} as Extract<AgentEvent, { type: "tool_result" }>;

beforeEach(() => {
  _resetStreamStateForTesting();
  _resetRevealSuccessRegistryForTest();
  resetForChatMintRegistryForTest();
  pendingStoreReads.length = 0;
});

describe("live reveal guard priming barrier", () => {
  test("a text delta dispatched while priming is pending waits for the guard and emits the sentinel", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // tool_use only STAGES the reveal — no store read may happen while the
    // command is merely proposed (it can still be denied or cancelled).
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    expect(pendingStoreReads.length).toBe(0);

    // The reveal route records its success (with the served plaintext) while
    // the tool runs; the result promotes the proven refs and starts priming.
    // The result dispatch is deliberately NOT awaited and the echo delta is
    // dispatched in the same tick — priming settles on a microtask, so the
    // barrier must hold the delta until then. The proven value means no store
    // read happens: redaction uses the route-served bytes directly.
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPENAI_PROJECT_KEY);
    const resultDispatch = dispatchAgentEvent(state, deps, REVEAL_TOOL_RESULT);
    const delta = dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: `Your key is ${SYNTHETIC_OPENAI_PROJECT_KEY} — rotate it.`,
    } as Extract<AgentEvent, { type: "text_delta" }>);

    // The store is never touched on the proven path.
    expect(pendingStoreReads.length).toBe(0);

    await resultDispatch;
    await delta;

    const streamed = streamedText(events);
    expect(streamed).toContain(
      "\u3014redacted:OpenAI Project Key:openai:api_key\u3015",
    );
    expect(streamed).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("a plaintext echo cannot beat the guard onto the wire", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPENAI_PROJECT_KEY);
    // Await the result dispatch fully (promotion + priming settle), then the
    // echo delta — the steady-state ordering. The sentinel must still appear.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_RESULT);
    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: `key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`,
    } as Extract<AgentEvent, { type: "text_delta" }>);

    const streamed = streamedText(events);
    expect(streamed).toContain(
      "\u3014redacted:OpenAI Project Key:openai:api_key\u3015",
    );
    expect(streamed).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("a denied or failed reveal never reads the store and stays unrevealable", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // `tool_use` is emitted before execution, so approval
    // denial / cancellation / the route's untrusted-shell block can still
    // stop the command. A blocked reveal never reaches the route, so no
    // success is recorded and the staged refs must be dropped without ever
    // touching the store — resolving at propose time would read plaintext
    // for a reveal that never ran, bypassing the route's own policy gates.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: "Command was denied by the user",
      isError: true,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    expect(pendingStoreReads.length).toBe(0);

    // The refs are gone for the rest of the turn, not merely deferred.
    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: "understood, not revealing anything",
    } as Extract<AgentEvent, { type: "text_delta" }>);
    expect(pendingStoreReads.length).toBe(0);
    expect(streamedText(events)).toContain("not revealing anything");
  });

  test("a successful shell command is not proof — no route success, no store read", async () => {
    const state = createEventHandlerState();
    const deps = createMockDeps([]);

    // `reveal … || true` (or an echo of the command text)
    // yields a SUCCESSFUL tool result even though the reveal route failed
    // or never ran. Without the route's own success record, the staged
    // refs must not promote.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_RESULT);
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a route success for a different identity does not promote the staged refs", async () => {
    const state = createEventHandlerState();
    const deps = createMockDeps([]);

    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("linear", "api_key", "sk-linear-other");
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_RESULT);
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a proven reveal primes even when the enclosing command exits non-zero", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // Compound command: the reveal route succeeded (secret is in the
    // model's context) but a later segment failed the tool overall. The
    // guard entry is protective here — the plaintext can still be echoed,
    // and the reveal's own stdout is redacted on the live tool_result.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPENAI_PROJECT_KEY);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: `${SYNTHETIC_OPENAI_PROJECT_KEY}\ncommand not found: bogus-follow-up`,
      isError: true,
    } as Extract<AgentEvent, { type: "tool_result" }>);
    // No store read on the proven path.
    expect(pendingStoreReads.length).toBe(0);
    // A subsequent echo of the plaintext still swaps to the sentinel.
    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: `again: ${SYNTHETIC_OPENAI_PROJECT_KEY}`,
    } as Extract<AgentEvent, { type: "text_delta" }>);
    expect(streamedText(events)).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("steady-state deltas with no priming in flight emit synchronously", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: "hello",
    } as Extract<AgentEvent, { type: "text_delta" }>);

    expect(pendingStoreReads.length).toBe(0);
    expect(streamedText(events)).toBe("hello");
  });

  test("a rotate-and-re-reveal in one window guards both served values", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // reveal (v1) → `credentials set` → reveal (v2) while the tool runs: the
    // route records BOTH plaintexts, both hit the tool's stdout and the
    // model's context, and neither is scanner-classifiable. Each must
    // become a candidate — keeping only the latest would stream the earlier
    // value raw on a later echo.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", "hunter2-rotated-alpha");
    recordRevealSuccess("openai", "api_key", "hunter2-rotated-beta");
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_RESULT);
    expect(pendingStoreReads.length).toBe(0);

    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: "old: hunter2-rotated-alpha new: hunter2-rotated-beta end",
    } as Extract<AgentEvent, { type: "text_delta" }>);

    const streamed = streamedText(events);
    expect(streamed).not.toContain("hunter2-rotated-alpha");
    expect(streamed).not.toContain("hunter2-rotated-beta");
    expect(streamed).toContain(
      "\u3014redacted:Credential:openai:api_key\u3015",
    );
  });
});

describe("reveal stdout redaction on the live tool_result", () => {
  test("an opaque revealed value in the reveal's own stdout is redacted before emit", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // The reveal prints an opaque/manual token the scanner cannot classify.
    // Without redaction here the live tool card would show it raw until a
    // history refetch; the emitted tool_result must already hide it.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPAQUE_CREDENTIAL);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    const results = toolResults(events);
    expect(results.length).toBe(1);
    expect(results[0]).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(results[0]).toContain("<redacted");
    expect(pendingStoreReads.length).toBe(0);
  });

  test("buffers the RAW tool result so persist redacts exactly once", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // The live emit is redacted, but the pending buffer must keep the raw
    // bytes: every persist path redacts via buildToolResultBlocks, and
    // buffering already-redacted content would redact twice — a candidate
    // value overlapping the marker's own text would corrupt the persisted
    // marker on the second pass.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPAQUE_CREDENTIAL);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    expect(toolResults(events)[0]).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(state.pendingToolResults.get("toolu_reveal")?.content).toBe(
      `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
    );
  });

  test("a tool_result that never revealed anything is forwarded unchanged", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // No reveal staged/proven — the fast path must not alter ordinary output.
    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "toolu_ls",
      name: "bash",
      input: { command: "ls -la" },
    } as Extract<AgentEvent, { type: "tool_use" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_ls",
      content: "total 0\ndrwxr-xr-x  2 user  staff",
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    const results = toolResults(events);
    expect(results[0]).toBe("total 0\ndrwxr-xr-x  2 user  staff");
    expect(pendingStoreReads.length).toBe(0);
  });
});

function outputChunks(events: ServerMessage[]): string[] {
  return events
    .filter(
      (e): e is Extract<ServerMessage, { type: "tool_output_chunk" }> =>
        (e as { type?: string }).type === "tool_output_chunk",
    )
    .map((e) => e.chunk);
}

describe("live tool output chunk redaction", () => {
  test("reveal stdout chunks are redacted before forwarding", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // The chunk streams WHILE the tool runs — before any tool_result — and
    // the drawer renders it live. The route recorded its success before the
    // CLI could print, so the guard has the proven value synchronously.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPAQUE_CREDENTIAL);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `value: ${SYNTHETIC_OPAQUE_CREDENTIAL}\n`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(streamedChunks).toContain('<redacted type="Credential" />');
    // Synchronous path — the guard never touches the store.
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a value split across chunks is held back, then flushed redacted", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPAQUE_CREDENTIAL);
    const head = SYNTHETIC_OPAQUE_CREDENTIAL.slice(0, 8);
    const tail = SYNTHETIC_OPAQUE_CREDENTIAL.slice(8);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `out: ${head}`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);
    // The partial prefix is held — nothing containing it is emitted yet.
    expect(outputChunks(events).join("")).toBe("out: ");
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `${tail} done`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).toBe('out: <redacted type="Credential" /> done');
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a held remainder is DISCARDED at tool_result, never emitted raw", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPAQUE_CREDENTIAL);
    // The stream ends mid-value: the tail is held when the result arrives.
    const head = SYNTHETIC_OPAQUE_CREDENTIAL.slice(0, 8);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_reveal",
      chunk: `out: ${head}`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_result",
      toolUseId: "toolu_reveal",
      content: `out: ${SYNTHETIC_OPAQUE_CREDENTIAL}`,
      isError: false,
    } as Extract<AgentEvent, { type: "tool_result" }>);

    // The held bytes are a raw credential prefix that complete-value
    // redaction cannot mask — they must never reach the wire. The redacted
    // final result supersedes the streamed view, so nothing is lost.
    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).toBe("out: ");
    expect(streamedChunks).not.toContain(head);
    expect(state.toolOutputGuardBuffers.size).toBe(0);
    const results = toolResults(events);
    expect(results[0]).toBe('out: <redacted type="Credential" />');
    expect(results[0]).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
  });

  test("chunks from a tool with no reveal candidates pass through verbatim", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "toolu_ls",
      name: "bash",
      input: { command: "ls -la" },
    } as Extract<AgentEvent, { type: "tool_use" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_ls",
      chunk: "total 0\n",
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    expect(outputChunks(events)).toEqual(["total 0\n"]);
    expect(pendingStoreReads.length).toBe(0);
  });

  test("a later tool echoing an already-promoted value is redacted too", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // Tool 1: the reveal, promoted at its result.
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_USE);
    recordRevealSuccess("openai", "api_key", SYNTHETIC_OPAQUE_CREDENTIAL);
    await dispatchAgentEvent(state, deps, REVEAL_TOOL_RESULT);
    // Tool 2: `echo <value>` — no reveal staged, but the promoted turn
    // candidates must still guard its live stdout.
    await dispatchAgentEvent(state, deps, {
      type: "tool_use",
      id: "toolu_echo",
      name: "bash",
      input: { command: "echo it back" },
    } as Extract<AgentEvent, { type: "tool_use" }>);
    await dispatchAgentEvent(state, deps, {
      type: "tool_output_chunk",
      toolUseId: "toolu_echo",
      chunk: `${SYNTHETIC_OPAQUE_CREDENTIAL}\n`,
    } as Extract<AgentEvent, { type: "tool_output_chunk" }>);

    const streamedChunks = outputChunks(events).join("");
    expect(streamedChunks).not.toContain(SYNTHETIC_OPAQUE_CREDENTIAL);
    expect(streamedChunks).toContain('<redacted type="Credential" />');
  });
});

describe("for-chat re-mint authority (two legs: staged AND executed)", () => {
  const FOR_CHAT_SENTINEL = "\u3014redacted:Credential:openai:api_key\u3015";

  const FOR_CHAT_TOOL_USE = {
    type: "tool_use",
    id: "toolu_forchat",
    name: "bash",
    input: {
      command:
        "assistant credentials reveal --for-chat --service openai --field api_key",
    },
  } as Extract<AgentEvent, { type: "tool_use" }>;

  const FOR_CHAT_TOOL_RESULT = {
    type: "tool_result",
    toolUseId: "toolu_forchat",
    content: FOR_CHAT_SENTINEL,
    isError: false,
  } as Extract<AgentEvent, { type: "tool_result" }>;

  test("staged by this run + route-minted: the echoed sentinel re-mints on the live wire", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    await dispatchAgentEvent(state, deps, FOR_CHAT_TOOL_USE);
    // The route records the mint while the tool executes (no plaintext
    // proof — the for-chat channel never returns the secret).
    recordForChatMint({
      service: "openai",
      field: "api_key",
      sentinel: FOR_CHAT_SENTINEL,
    });
    await dispatchAgentEvent(state, deps, FOR_CHAT_TOOL_RESULT);

    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: `Here it is: ${FOR_CHAT_SENTINEL} — click to reveal.`,
    } as Extract<AgentEvent, { type: "text_delta" }>);

    expect(streamedText(events)).toContain(FOR_CHAT_SENTINEL);
    expect(streamedText(events)).not.toContain("\u2060");
  });

  test("a mint alone — identity never staged by this run — neutralizes (env-override redirect grants nothing)", async () => {
    // Simulates the redirect attack: another conversation's shell command
    // overrode the CLI env so ITS executed reveal recorded a mint while
    // this run never staged the identity. The mint passes the watermark
    // check but fails the staging leg, so the echoed sentinel neutralizes
    // like any forgery.
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    recordForChatMint({
      service: "openai",
      field: "api_key",
      sentinel: FOR_CHAT_SENTINEL,
    });

    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: `forged: ${FOR_CHAT_SENTINEL}!`,
    } as Extract<AgentEvent, { type: "text_delta" }>);

    expect(streamedText(events)).not.toContain(FOR_CHAT_SENTINEL);
    expect(streamedText(events)).toContain("\u3014\u2060redacted:");
  });

  test("staging alone — a quoted command that never executed — neutralizes", async () => {
    const events: ServerMessage[] = [];
    const state = createEventHandlerState();
    const deps = createMockDeps(events);

    // Staged (the parse cannot tell a quoted invocation from a real one)…
    await dispatchAgentEvent(state, deps, FOR_CHAT_TOOL_USE);
    await dispatchAgentEvent(state, deps, FOR_CHAT_TOOL_RESULT);
    // …but the route never ran, so no mint exists.

    await dispatchAgentEvent(state, deps, {
      type: "text_delta",
      text: `quoted: ${FOR_CHAT_SENTINEL}`,
    } as Extract<AgentEvent, { type: "text_delta" }>);

    expect(streamedText(events)).not.toContain(FOR_CHAT_SENTINEL);
    expect(streamedText(events)).toContain("\u3014\u2060redacted:");
  });
});
