/**
 * `<channel_capabilities>` must not accumulate one copy per turn, and
 * deduplicating it must not disturb the cross-turn byte-identity that prompt
 * caching depends on (see `prompt-cache-cross-turn-stability.test.ts`, which
 * owns that invariant end to end).
 */
import { describe, expect, test } from "bun:test";

import {
  dedupeChannelCapabilityBlocks,
  preModelCallSanitize,
} from "../context/outbound-sanitize.js";
import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Fixtures, shaped like what runtime injection actually produces: the block is
// its OWN text content block, prepended to the turn-starting user message by
// `injectChannelCapabilityContext`, and then frozen into history.
// ---------------------------------------------------------------------------

const slackCapabilities = (dynamicUi = false): string =>
  [
    "<channel_capabilities>",
    "channel: slack",
    "dashboard_capable: false",
    `supports_dynamic_ui: ${dynamicUi}`,
    "supports_voice_input: false",
    "",
    "CHANNEL CONSTRAINTS:",
    "- Do NOT reference the dashboard UI, settings panels, or visual preference pickers.",
    '- Do NOT use app_create. Only use ui_show/ui_update for card surfaces with template: "task_progress"; present all other information as text.',
    "- Present information as well-formatted text instead of dynamic UI.",
    "</channel_capabilities>",
  ].join("\n");

const CAPS = slackCapabilities();

const turnContextBlock = (turn: number): string =>
  [
    "<turn_context>",
    `current_time: 2026-05-21 (Thursday) 10:${String(turn).padStart(2, "0")}:00 -05:00 (America/Chicago)`,
    "interface: slack",
    "trust_class: guardian",
    "</turn_context>",
  ].join("\n");

const userTurn = (turn: number, caps: string = CAPS): Message => ({
  role: "user",
  content: [
    { type: "text", text: turnContextBlock(turn) },
    { type: "text", text: caps },
    { type: "text", text: `User message ${turn}.` },
  ],
});

const assistantTurn = (turn: number): Message => ({
  role: "assistant",
  content: [{ type: "text", text: `Reply ${turn}.` }],
});

/** An N-turn conversation, every user row carrying its own injected copy. */
const conversation = (turns: number): Message[] => {
  const messages: Message[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push(userTurn(turn));
    if (turn < turns) {
      messages.push(assistantTurn(turn));
    }
  }
  return messages;
};

const allText = (messages: Message[]): string =>
  messages
    .flatMap((m) =>
      m.content.filter((b) => b.type === "text").map((b) => b.text),
    )
    .join("\n");

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------

describe("<channel_capabilities> does not accumulate across a conversation", () => {
  test("a 50-turn conversation carries exactly one copy", () => {
    const raw = conversation(50);
    expect(countOccurrences(allText(raw), "<channel_capabilities>")).toBe(50);

    const text = allText(preModelCallSanitize(raw));
    expect(countOccurrences(text, "<channel_capabilities>")).toBe(1);
    expect(countOccurrences(text, "CHANNEL CONSTRAINTS:")).toBe(1);
  });

  test("the surviving copy is the first one, unmodified", () => {
    const sanitized = preModelCallSanitize(conversation(6));
    expect(sanitized[0].content).toEqual(conversation(6)[0].content);
    expect(allText([sanitized[2]])).not.toContain("<channel_capabilities>");
  });

  test("outbound size stops growing with the repeated block", () => {
    const rawGrowth =
      allText(conversation(45)).length - allText(conversation(5)).length;
    const sanitizedGrowth =
      allText(preModelCallSanitize(conversation(45))).length -
      allText(preModelCallSanitize(conversation(5))).length;

    // Every extra raw turn pays for a full copy of the block; the deduplicated
    // projection pays nothing for it.
    expect((rawGrowth - sanitizedGrowth) / 40).toBeGreaterThanOrEqual(
      CAPS.length,
    );
  });

  test("everything else on the row is untouched", () => {
    const sanitized = preModelCallSanitize(conversation(4));
    // `<turn_context>` is deliberately left alone: it carries a fresh
    // timestamp each turn and historical copies are read back by the
    // compactor's tail resolution.
    expect(countOccurrences(allText(sanitized), "<turn_context>")).toBe(4);
    // The dropped block is the only thing that goes: the row keeps its
    // `<turn_context>` and the user's own text, in order.
    expect(sanitized[6].content).toEqual([
      { type: "text", text: turnContextBlock(4) },
      { type: "text", text: "User message 4." },
    ]);
  });
});

describe("cross-turn byte stability", () => {
  test("a message renders identically no matter how many turns follow it", () => {
    // The prompt cache is only readable when turn N's messages recur
    // byte-identically at the same index in turn N+1. Deduplication must
    // therefore depend only on what sits ABOVE a message, never on how far it
    // is from the end.
    const turn2 = preModelCallSanitize(conversation(2));
    const turn20 = preModelCallSanitize(conversation(20));

    turn2.forEach((message, index) => {
      expect(JSON.stringify(turn20[index])).toBe(JSON.stringify(message));
    });
  });

  test("the turn-starting message is not treated specially", () => {
    const sanitized = preModelCallSanitize(conversation(3));
    const turnStart = sanitized[sanitized.length - 1];
    // Turn 3 opened this turn and still drops its duplicate copy, which is
    // exactly what keeps it stable once turn 4 arrives.
    expect(allText([turnStart])).not.toContain("<channel_capabilities>");
  });

  test("is idempotent", () => {
    const once = preModelCallSanitize(conversation(6));
    expect(preModelCallSanitize(once)).toEqual(once);
  });
});

describe("changes and safety", () => {
  test("capabilities that actually change mid-conversation are kept", () => {
    const changed = slackCapabilities(true);
    const history: Message[] = [
      userTurn(1),
      assistantTurn(1),
      userTurn(2),
      assistantTurn(2),
      userTurn(3, changed),
      assistantTurn(3),
      userTurn(4, changed),
    ];

    const sanitized = dedupeChannelCapabilityBlocks(history);
    const text = allText(sanitized);
    expect(countOccurrences(text, "<channel_capabilities>")).toBe(2);
    expect(text).toContain("supports_dynamic_ui: false");
    expect(text).toContain("supports_dynamic_ui: true");
    // Turn 2 and turn 4 are the repeats and are the ones that go.
    expect(allText([sanitized[2]])).not.toContain("<channel_capabilities>");
    expect(allText([sanitized[6]])).not.toContain("<channel_capabilities>");
  });

  test("a conversation with a single copy is returned untouched", () => {
    const history = conversation(1);
    expect(dedupeChannelCapabilityBlocks(history)).toBe(history);
  });

  test("user-authored text that merely mentions the tag is left alone", () => {
    const authored =
      "why does <channel_capabilities> say dashboard_capable: false?";
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: authored }] },
      assistantTurn(1),
      { role: "user", content: [{ type: "text", text: authored }] },
    ];

    expect(dedupeChannelCapabilityBlocks(history)).toBe(history);
  });

  test("a user row made only of the block is never emptied or dropped", () => {
    const history: Message[] = [
      userTurn(1),
      assistantTurn(1),
      { role: "user", content: [{ type: "text", text: CAPS }] },
      assistantTurn(2),
      userTurn(3),
    ];

    const sanitized = dedupeChannelCapabilityBlocks(history);
    expect(sanitized).toHaveLength(5);
    expect(sanitized[2].content).toEqual(history[2].content);
    // The all-block row is retained, so it becomes the baseline the later
    // duplicate is measured against and turn 3 still drops.
    expect(allText([sanitized[4]])).not.toContain("<channel_capabilities>");
  });
});
