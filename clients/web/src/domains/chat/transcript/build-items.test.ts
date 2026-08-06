import { describe, expect, test } from "bun:test";

import type { DisplayMessage, Surface } from "@/domains/chat/types/types";
import { buildTranscriptItems } from "@/domains/chat/transcript/build-items";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { mergeAdjacentAssistantMessages } from "@/domains/chat/utils/message-merge";
import { textBody } from "@/domains/chat/utils/message-test-helpers";
function makeMessage(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return {
    id: id ?? crypto.randomUUID(),
    ...rest,
  };
}

function makeSurface(
  overrides: Partial<Surface> & { surfaceId: string },
): Surface {
  return {
    surfaceType: "test-surface",
    data: {},
    ...overrides,
  };
}

function emptyInput() {
  return {
    messages: [] as DisplayMessage[],
    pendingSecret: null,
    pendingConfirmation: null,
    isThinking: false,
  };
}

function expectDistinctNonEmptyKeys(items: TranscriptItem[]): void {
  const keys = items.map((i) => i.key);
  for (const key of keys) {
    expect(key.length).toBeGreaterThan(0);
  }
  expect(new Set(keys).size).toBe(keys.length);
}

describe("buildTranscriptItems", () => {
  test("projects plain user + assistant messages into two MessageItems in order", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const assistant = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("Hi"),
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "message", key: "m1", message: user });
    expect(items[1]).toEqual({
      kind: "message",
      key: "m2",
      message: assistant,
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("excludes subagent-notification messages from the projection but leaves input intact", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const notification = makeMessage({
      id: "m2",
      role: "user",
      ...textBody('[Subagent "research" completed]'),
      isSubagentNotification: true,
    });
    const assistant = makeMessage({
      id: "m3",
      role: "assistant",
      ...textBody("Hi"),
    });
    const messages = [user, notification, assistant];

    const items = buildTranscriptItems({ ...emptyInput(), messages });

    // The subagent-notification row is never rendered in the transcript...
    expect(items).toEqual([
      { kind: "message", key: "m1", message: user },
      { kind: "message", key: "m3", message: assistant },
    ]);
    // ...but it remains in the input `messages` state so the LLM transcript and
    // subagent-store rehydration still see it (suppression is render-only).
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(notification);
  });

  test("excludes acp-notification messages from the projection but leaves input intact", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const notification = makeMessage({
      id: "m2",
      role: "user",
      ...textBody('[ACP agent "claude" completed]'),
      isAcpNotification: true,
    });
    const assistant = makeMessage({
      id: "m3",
      role: "assistant",
      ...textBody("Hi"),
    });
    const messages = [user, notification, assistant];

    const items = buildTranscriptItems({ ...emptyInput(), messages });

    expect(items).toEqual([
      { kind: "message", key: "m1", message: user },
      { kind: "message", key: "m3", message: assistant },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(notification);
  });

  test("excludes background-tool notification messages from the projection but leaves input intact", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const notification = makeMessage({
      id: "m2",
      role: "user",
      ...textBody(
        '<background_event source="background-tool">Background command completed (id=bg-1, exit=0):</background_event>',
      ),
      isBackgroundEventNotification: true,
    });
    const assistant = makeMessage({
      id: "m3",
      role: "assistant",
      ...textBody("Build finished."),
    });
    const messages = [user, notification, assistant];

    const items = buildTranscriptItems({ ...emptyInput(), messages });

    expect(items).toEqual([
      { kind: "message", key: "m1", message: user },
      { kind: "message", key: "m3", message: assistant },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(notification);
  });

  test("emits empty list when there is no state", () => {
    const items = buildTranscriptItems(emptyInput());
    expect(items).toEqual([]);
  });

  test("projects ephemeralMetaResults as tail cards after messages", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      ephemeralMetaResults: [
        { id: "e1", kind: "clean", text: "Context Cleaned" },
        { id: "e2", kind: "info", text: "Available models" },
      ],
    });

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "message", key: "m1" });
    expect(items[1]).toMatchObject({ kind: "ephemeralMeta", key: "meta-e1" });
    expect(items[2]).toMatchObject({ kind: "ephemeralMeta", key: "meta-e2" });
    expectDistinctNonEmptyKeys(items);
  });

  test("surfaces on messages are rendered within the message item (no standalone rows)", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const surface = makeSurface({
      surfaceId: "surf-1",
      display: "inline",
    });
    const assistant = makeMessage({
      role: "assistant",
      ...textBody("See surface"),
      id: "s-assistant",
      surfaces: [surface],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "surface", id: "surf-1" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message", key: "m1" });
    expect(items[1]).toMatchObject({ kind: "message", key: "s-assistant" });
    expectDistinctNonEmptyKeys(items);
  });

  test("completed surfaces stay on the message (no standalone rows)", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const completedSurface = makeSurface({
      surfaceId: "done-A",
      completed: true,
      completionSummary: "Done",
    });
    const assistant = makeMessage({
      role: "assistant",
      ...textBody("Ok"),
      id: "s-assistant",
      surfaces: [completedSurface],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("message");
    expect(items[1]!.kind).toBe("message");
    expectDistinctNonEmptyKeys(items);
  });

  test("isThinking inserts ThinkingItem first in the trailers", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      isThinking: true,
    });

    // message, thinking — thinking is the FIRST trailer.
    expect(items.map((i) => i.kind)).toEqual(["message", "thinking"]);
    expect(items[1]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
    });
  });

  test("turnActive keeps an inactive ThinkingItem mounted when isThinking is false", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: false,
      turnActive: true,
    });

    // The slot exists for the whole in-flight turn (fixed height, no reflow)
    // but is inactive — the render layer fades the label out.
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: false,
    });
  });

  test("no ThinkingItem when neither isThinking nor turnActive", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: false,
      turnActive: false,
    });

    expect(items).toHaveLength(0);
  });

  test("ThinkingItem includes label when thinkingLabel is provided", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: "Processing bash results",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
      label: "Processing bash results",
    });
  });

  test("ThinkingItem omits label when thinkingLabel is null", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: null,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
    });
  });

  test("ThinkingItem omits label when thinkingLabel is empty string", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: "",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      active: true,
    });
  });

  test("pendingSecret comes before pendingConfirmation", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
    });

    expect(items.map((i) => i.kind)).toEqual([
      "pendingSecret",
      "pendingConfirmation",
    ]);
    expect(items[0]).toEqual({
      kind: "pendingSecret",
      key: "secret-req-s",
      requestId: "req-s",
    });
    expect(items[1]).toEqual({
      kind: "pendingConfirmation",
      key: "confirmation-req-c",
      requestId: "req-c",
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("full trailer order: thinking → pendingSecret → pendingConfirmation", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      isThinking: true,
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
    });

    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "thinking",
      "pendingSecret",
      "pendingConfirmation",
    ]);
    expectDistinctNonEmptyKeys(items);
  });

  test("every item has a non-empty, distinct key in a mixed transcript", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const inline1 = makeSurface({ surfaceId: "inline-1", display: "inline" });
    const inline2 = makeSurface({ surfaceId: "inline-2", display: "inline" });
    const assistantA = makeMessage({
      role: "assistant",
      ...textBody("A"),
      id: "s-a",
    });
    const assistantB = makeMessage({
      role: "assistant",
      ...textBody("B"),
      id: "s-b",
      surfaces: [inline1, inline2],
    });

    const items = buildTranscriptItems({
      messages: [user, assistantA, assistantB],
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
      isThinking: true,
    });

    expectDistinctNonEmptyKeys(items);
  });

  test("message item carries through the underlying DisplayMessage by reference", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
    });
    const messageItem = items[0] as MessageItem;
    expect(messageItem.message).toBe(user);
  });

  // ---------------------------------------------------------------------------
  // Phantom tool-only message filter (ATL-659) — pass-through behaviour only
  //
  // The drop-the-phantom logic now lives in `sanitizeDisplayMessages` and is
  // exercised by `sanitize-display-messages.test.ts`. The tests below
  // confirm that `buildTranscriptItems` does NOT mistakenly drop legitimate
  // mixed-tool messages — the positive half of the original spec.
  // ---------------------------------------------------------------------------

  test("mixed messages with unknown tool calls alongside content are kept", () => {
    const mixed = makeMessage({
      role: "user",
      ...textBody("Here is the result."),
      id: "s-mixed",
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixed],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixed);
  });

  test("messages with mixed known + unknown tool calls are kept", () => {
    const mixedKnown = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-mixed-known",
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
        {
          id: "tc-2",
          name: "bash",
          input: { command: "ls" },
          completedAt: 1,
          result: "file.txt",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedKnown],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedKnown);
  });

  test("messages with surfaces are kept even with unknown tool calls", () => {
    const surface = makeSurface({ surfaceId: "surf-1", display: "inline" });
    const mixedSurface = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-mixed-surface",
      surfaces: [surface],
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedSurface],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedSurface);
  });

  test("messages with attachments are kept even with unknown tool calls", () => {
    const mixedAttachment = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-mixed-attachment",
      attachments: [
        {
          id: "a1",
          filename: "test.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          previewUrl: null,
        },
      ],
      toolCalls: [
        {
          id: "tc-1",
          name: "unknown",
          input: {},
          completedAt: 1,
          result: "orphan",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedAttachment],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedAttachment);
  });

  test("real tool-only messages (known toolName) are kept", () => {
    const realTool = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-real-tool",
      toolCalls: [
        {
          id: "tc-1",
          name: "bash",
          input: { command: "ls" },
          completedAt: 1,
          result: "file.txt",
        },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [realTool],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(realTool);
  });

  // ---------------------------------------------------------------------------
  // Blank user-row filter — pass-through behaviour only
  //
  // The drop-blank-rows logic now lives in `sanitizeDisplayMessages` and is
  // exercised by `sanitize-display-messages.test.ts`. The tests below
  // confirm that `buildTranscriptItems` does NOT mistakenly drop legitimate
  // user rows whose `content` is empty but which carry segments, surfaces,
  // attachments, or are in a queued state — the positive half of the spec.
  // ---------------------------------------------------------------------------

  test("user rows with non-empty textSegments are kept (even if content is empty)", () => {
    // Some history paths populate textSegments instead of (or in addition to)
    // the flat content field — those rows are meaningful and must render.
    const segmentsOnly = makeMessage({
      role: "user",
      id: "s-segments-only",
      textSegments: ["Hello via segments"],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [segmentsOnly],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(segmentsOnly);
  });

  test("user rows with slackMessage chip are kept (even if content is empty)", () => {
    const slack = makeMessage({
      role: "user",
      ...textBody(""),
      id: "s-slack",
      slackMessage: {
        channelId: "C123",
        channelTs: "1700000000.000100",
      },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [slack],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(slack);
  });

  test("queued user rows are omitted from the transcript", () => {
    // The queue drawer is the only visible queue surface. Optimistic queued
    // user rows remain in state so the drawer can render and manage them, but
    // the transcript itself should not add a duplicate queued marker row.
    const queued = makeMessage({
      role: "user",
      ...textBody("Send when ready"),
      id: "s-queued",
      isOptimistic: true,
      queueStatus: "queued",
      queuePosition: 1,
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [queued],
    });

    expect(items).toEqual([]);
  });

  test("assistant blank rows are NOT dropped (filter is user-only)", () => {
    // Assistant rows can legitimately be empty during streaming setup —
    // the streaming layer fills them in. The blank-row filter must not
    // touch them.
    const blankAssistant = makeMessage({
      role: "assistant",
      ...textBody(""),
      id: "s-assistant-blank",
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [blankAssistant],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(blankAssistant);
  });

  // ---------------------------------------------------------------------------
  // Provider-error rows: credits-exhausted substitution
  //
  // The substitution requires the live `creditsExhausted` flag alongside the
  // persisted row tag, so gated/self-hosted contexts (inert billing hook) and
  // recovered balances keep the plain historical bubble.
  // ---------------------------------------------------------------------------

  test("credits-exhausted provider-error rows emit a creditsUpsell item while the balance is exhausted", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const errorRow = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, errorRow],
      creditsExhausted: true,
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "message", key: "m1", message: user });
    expect(items[1]).toEqual({
      kind: "creditsUpsell",
      key: "credits-upsell-m2",
      message: errorRow,
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("code-only provider-error rows (no category) substitute the card too", () => {
    // The daemon builds `providerError` with each field conditional on being
    // a string, so a persisted row can carry a bare PROVIDER_BILLING code.
    // The substitution classifies via `isCreditsExhaustedProviderError`,
    // which accepts that shape as managed credits.
    const errorRow = makeMessage({
      id: "m1",
      role: "assistant",
      ...textBody("I hit a snag: your credits ran out."),
      providerError: { code: "PROVIDER_BILLING" },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [errorRow],
      creditsExhausted: true,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "creditsUpsell",
      key: "credits-upsell-m1",
      message: errorRow,
    });
  });

  test("empty provider-error markers (no code, no category) keep the normal message rendering", () => {
    const errorRow = makeMessage({
      id: "m1",
      role: "assistant",
      ...textBody("Something went wrong."),
      providerError: {},
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [errorRow],
      creditsExhausted: true,
    });

    // The row keeps its bubble; the exhausted balance still appends the
    // proactive tail card after it.
    expect(items.map((i) => i.kind)).toEqual(["message", "creditsUpsell"]);
    expect((items[0] as MessageItem).message).toBe(errorRow);
  });

  test("adjacent assistant + provider-error rows survive the client fold and still substitute the card", () => {
    // The history-pagination fold must treat provider-error rows as
    // standalone (mirroring the daemon's `isStandaloneAssistantRow`); a fold
    // would drop the marker and with it the card.
    const assistant = makeMessage({
      id: "m1",
      role: "assistant",
      ...textBody("Partial answer before the failure."),
    });
    const errorRow = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    });

    const folded = mergeAdjacentAssistantMessages([assistant, errorRow]);
    expect(folded).toHaveLength(2);

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: folded,
      creditsExhausted: true,
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      kind: "message",
      key: "m1",
      message: assistant,
    });
    expect(items[1]).toEqual({
      kind: "creditsUpsell",
      key: "credits-upsell-m2",
      message: errorRow,
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("provider-error rows of other categories keep the normal message rendering", () => {
    const errorRow = makeMessage({
      id: "m1",
      role: "assistant",
      ...textBody("The provider rejected the request."),
      providerError: { code: "PROVIDER_ERROR", category: "rate_limited" },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [errorRow],
      creditsExhausted: true,
    });

    // The row keeps its bubble; the exhausted balance still appends the
    // proactive tail card after it.
    expect(items.map((i) => i.kind)).toEqual(["message", "creditsUpsell"]);
    expect(items[0]).toEqual({
      kind: "message",
      key: "m1",
      message: errorRow,
    });
  });

  test("untagged rows (no providerError) keep the normal message rendering", () => {
    const plain = makeMessage({
      id: "m1",
      role: "assistant",
      ...textBody("A plain historical error bubble."),
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [plain],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(plain);
  });

  test("returns stable creditsUpsell item references for unchanged message objects across calls", () => {
    const errorRow = makeMessage({
      id: "m1",
      role: "assistant",
      providerError: { category: "credits_exhausted" },
    });

    const first = buildTranscriptItems({
      ...emptyInput(),
      messages: [errorRow],
      creditsExhausted: true,
    });
    const second = buildTranscriptItems({
      ...emptyInput(),
      messages: [errorRow],
      creditsExhausted: true,
    });

    expect(second[0]).toBe(first[0]!);
  });

  test("tagged rows keep the normal message rendering while the balance is not exhausted", () => {
    // Covers both a topped-up balance and contexts where the billing hook is
    // inert (self-hosted/gated assistants, no platform session): the
    // persisted assistant-voice text renders as a plain historical bubble
    // instead of a live-looking card the context cannot act on.
    const errorRow = makeMessage({
      id: "m1",
      role: "assistant",
      ...textBody("I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    });

    for (const creditsExhausted of [false, undefined]) {
      const items = buildTranscriptItems({
        ...emptyInput(),
        messages: [errorRow],
        creditsExhausted,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        kind: "message",
        key: "m1",
        message: errorRow,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Proactive exhausted-balance card
  //
  // Derived entirely from inputs the projection already has: appended while
  // `creditsExhausted` with no turn in flight and at least one message.
  // ---------------------------------------------------------------------------

  test("an exhausted balance appends the proactive card after the messages", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const assistant = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("Hi"),
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
      creditsExhausted: true,
    });

    expect(items).toHaveLength(3);
    expect(items[2]).toEqual({
      kind: "creditsUpsell",
      key: "credits-upsell-proactive",
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("no proactive card without messages (the empty state renders its own)", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      creditsExhausted: true,
    });

    expect(items).toEqual([]);
  });

  test("no proactive card while a turn is in flight", () => {
    // A credit wall never renders under the live progress indicator; the
    // turn-settled billing refetch re-shows it as soon as the turn ends.
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      turnActive: true,
      creditsExhausted: true,
    });

    expect(items.map((i) => i.kind)).toEqual(["message", "thinking"]);
  });

  test("proactive card lands before trailers (thinking slot, onboarding choice)", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      isThinking: true,
      showOnboardingChoice: true,
      creditsExhausted: true,
    });

    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "creditsUpsell",
      "thinking",
      "onboardingChoice",
    ]);
    expectDistinctNonEmptyKeys(items);
  });

  test("no proactive card when the last item is already the substituted upsell (just-failed turn)", () => {
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const errorRow = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, errorRow],
      creditsExhausted: true,
    });

    // Exactly one card: the substituted one from the failed turn.
    expect(items.filter((i) => i.kind === "creditsUpsell")).toHaveLength(1);
    expect(items[items.length - 1]).toEqual({
      kind: "creditsUpsell",
      key: "credits-upsell-m2",
      message: errorRow,
    });
  });

  test("trailers after the substituted upsell do not defeat the dedupe", () => {
    // The dedupe consults the last message-derived item, so trailer rows
    // (onboarding choice, thinking slot, pending prompts) between the
    // substituted card and the tail must not produce a second card.
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const errorRow = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, errorRow],
      showOnboardingChoice: true,
      creditsExhausted: true,
    });

    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "creditsUpsell",
      "onboardingChoice",
    ]);
    expectDistinctNonEmptyKeys(items);
  });

  test("a still-busy failed turn shows only the substituted card", () => {
    // `turnActive` suppresses the proactive tail card outright, so the
    // substituted card and the thinking slot are all that render.
    const errorRow = makeMessage({
      id: "m1",
      role: "assistant",
      ...textBody("I hit a snag: your credits ran out."),
      providerError: {
        code: "PROVIDER_BILLING",
        category: "credits_exhausted",
      },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [errorRow],
      turnActive: true,
      creditsExhausted: true,
    });

    expect(items.map((i) => i.kind)).toEqual(["creditsUpsell", "thinking"]);
    expect(items.filter((i) => i.kind === "creditsUpsell")).toHaveLength(1);
    expectDistinctNonEmptyKeys(items);
  });

  test("an old substituted upsell followed by later messages still gets the proactive tail card", () => {
    // The dedupe consults only the LAST message-derived item: a historical
    // exhaustion (topped up, conversation continued, exhausted again) should
    // not suppress the new tail card.
    const errorRow = makeMessage({
      id: "m1",
      role: "assistant",
      providerError: { category: "credits_exhausted" },
    });
    const later = makeMessage({
      id: "m2",
      role: "assistant",
      ...textBody("Back in business."),
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [errorRow, later],
      creditsExhausted: true,
    });

    expect(items.map((i) => i.kind)).toEqual([
      "creditsUpsell",
      "message",
      "creditsUpsell",
    ]);
    expectDistinctNonEmptyKeys(items);
  });

  test("returns a stable proactive item reference across calls", () => {
    const message = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });

    const first = buildTranscriptItems({
      ...emptyInput(),
      messages: [message],
      creditsExhausted: true,
    });
    const second = buildTranscriptItems({
      ...emptyInput(),
      messages: [message],
      creditsExhausted: true,
    });

    expect(second[1]).toBe(first[1]!);
  });

  // ---------------------------------------------------------------------------
  // Confirmation path — inline attachment vs standalone fallback
  // ---------------------------------------------------------------------------

  test("pendingConfirmation: null suppresses the standalone confirmation row (inline attached)", () => {
    // When inline confirmation is attached to a tool call, the page sets
    // pendingConfirmation to null so the standalone row does not appear.
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      pendingConfirmation: null,
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect(items.some((i) => i.kind === "pendingConfirmation")).toBe(false);
  });

  test("pendingConfirmation present emits standalone row (no inline attachment)", () => {
    // When no tool call matches, the standalone confirmation row must appear.
    const user = makeMessage({ id: "m1", role: "user", ...textBody("Hi") });
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      pendingConfirmation: { requestId: "req-standalone" },
    });

    const confItems = items.filter((i) => i.kind === "pendingConfirmation");
    expect(confItems).toHaveLength(1);
    expect(confItems[0]!.key).toBe("confirmation-req-standalone");
  });

  test("pendingConfirmation alone (no messages) still emits the row", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      pendingConfirmation: { requestId: "req-solo" },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "pendingConfirmation",
      key: "confirmation-req-solo",
      requestId: "req-solo",
    });
  });

  // ---------------------------------------------------------------------------
  // Inline surfaces never suppress messages
  // ---------------------------------------------------------------------------

  test("surface in contentOrder is part of message item (no standalone row)", () => {
    const wakeSurface = makeSurface({
      surfaceId: "wake-123",
      surfaceType: "card",
      display: "inline",
      title: "Conversation Woke",
    });
    const assistant = makeMessage({
      role: "assistant",
      id: "s-assistant",
      toolCalls: [
        {
          id: "tc-1",
          name: "bash",
          input: { command: "echo hi" },
          completedAt: 1,
        },
      ],
      textSegments: ["Pushed. Catalog regenerated."],
      contentOrder: [
        { type: "toolCall", id: "tc-1" },
        { type: "text", id: "0" },
        { type: "surface", id: "wake-123" },
      ],
      surfaces: [wakeSurface],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [assistant],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(assistant);
  });

  test("surfaces on messages do not create standalone rows", () => {
    const surface = makeSurface({
      surfaceId: "surf-app",
      surfaceType: "dynamic_page",
      display: "inline",
    });
    const assistant = makeMessage({
      role: "assistant",
      ...textBody(""),
      id: "s-assistant",
      surfaces: [surface],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [assistant],
    });

    // Only the message item — surfaces live on the message, not as standalone rows
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(assistant);
  });

  // ---------------------------------------------------------------------------
  // MessageItem memoization (WeakMap cache)
  // ---------------------------------------------------------------------------

  test("returns stable MessageItem references for unchanged message objects across calls", () => {
    const m1 = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const m2 = makeMessage({ id: "m2", role: "assistant", ...textBody("Hi") });

    const first = buildTranscriptItems({ ...emptyInput(), messages: [m1, m2] });
    const second = buildTranscriptItems({
      ...emptyInput(),
      messages: [m1, m2],
    });

    expect(first[0]).toBe(second[0]);
    expect(first[1]).toBe(second[1]);
  });

  test("returns a new MessageItem only for the message whose object changed", () => {
    const m1 = makeMessage({ id: "m1", role: "user", ...textBody("Hello") });
    const m2 = makeMessage({ id: "m2", role: "assistant", ...textBody("Hi") });

    const first = buildTranscriptItems({ ...emptyInput(), messages: [m1, m2] });

    // Simulate a streaming token appending to m2 — creates a new object
    const m2Updated = { ...m2, content: "Hi there" };
    const second = buildTranscriptItems({
      ...emptyInput(),
      messages: [m1, m2Updated],
    });

    // m1's item is still the same reference (cache hit)
    expect(second[0]).toBe(first[0]);
    // m2's item is a new reference (cache miss — different object)
    expect(second[1]).not.toBe(first[1]);
    expect((second[1] as MessageItem).message).toBe(m2Updated);
  });

  test("uses clientMessageId as key when available, falls back to id", () => {
    const withClientId = makeMessage({
      id: "server-id-123",
      role: "user",
      ...textBody("Hello"),
      clientMessageId: "client-id-abc",
    });
    const withoutClientId = makeMessage({
      id: "server-id-456",
      role: "assistant",
      ...textBody("Hi"),
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [withClientId, withoutClientId],
    });

    expect(items[0]!.key).toBe("client-id-abc");
    expect(items[1]!.key).toBe("server-id-456");
  });
});
