/**
 * Tests for the channel-native question wizard state machine
 * (`channel-questions.ts`).
 *
 * Exercises the record → advance → submit transitions against the real
 * `pendingInteractions` tracker and the shared `resolvePendingQuestion`
 * resolver (no mocks): tap recording with the index guard, free-text recording,
 * multi-question advancement, completion + rpcResolve payload, and the
 * outbound-rendering helpers the watcher consumes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { QuestionEntry } from "../../api/events/question-request.js";
import type { QuestionPromptResult } from "../../permissions/question-prompter.js";
import {
  _clearAllQuestionWizardState,
  buildQuestionWizardStep,
  buildQuestionWizardSummary,
  ensureQuestionWizardState,
  getPendingQuestionInfoByConversation,
  getQuestionWizardStateByConversation,
  recordQuestionFreeTextForConversation,
  recordQuestionTap,
  setQuestionWizardMessageTs,
} from "../channel-questions.js";
import * as pendingInteractions from "../pending-interactions.js";

const CONV = "conv-1";

function registerQuestion(
  requestId: string,
  entries: QuestionEntry[],
  rpcResolve: (value: unknown) => void = () => {},
): void {
  const optionsById: Record<string, string[]> = {};
  for (const e of entries) {
    optionsById[e.id] = e.options.map((o) => o.id);
  }
  pendingInteractions.register(requestId, {
    conversationId: CONV,
    kind: "question",
    rpcResolve,
    metadata: { orderedIds: entries.map((e) => e.id), optionsById },
    questionDetails: { entries },
  });
}

const singleEntry: QuestionEntry[] = [
  {
    id: "q1",
    question: "Which fruit?",
    description: "Pick one.",
    options: [
      { id: "a", label: "Apple" },
      { id: "b", label: "Banana" },
    ],
    freeTextPlaceholder: "Type a fruit",
  },
];

const twoEntries: QuestionEntry[] = [
  {
    id: "q1",
    question: "Which fruit?",
    options: [
      { id: "a", label: "Apple" },
      { id: "b", label: "Banana" },
    ],
  },
  {
    id: "q2",
    question: "Which size?",
    options: [
      { id: "s", label: "Small" },
      { id: "l", label: "Large" },
    ],
  },
];

beforeEach(() => {
  pendingInteractions.clear();
  _clearAllQuestionWizardState();
});

afterEach(() => {
  pendingInteractions.clear();
  _clearAllQuestionWizardState();
});

describe("getPendingQuestionInfoByConversation", () => {
  test("returns only pending question interactions with details", () => {
    registerQuestion("req-1", singleEntry);
    pendingInteractions.register("conf-1", {
      conversationId: CONV,
      kind: "confirmation",
    });

    const infos = getPendingQuestionInfoByConversation(CONV);
    expect(infos).toHaveLength(1);
    expect(infos[0].requestId).toBe("req-1");
    expect(infos[0].entries[0].id).toBe("q1");
  });
});

describe("buildQuestionWizardStep", () => {
  test("renders the current entry as single-entry metadata", () => {
    registerQuestion("req-1", twoEntries);
    const state = ensureQuestionWizardState("req-1")!;

    const step = buildQuestionWizardStep(state);
    expect(step).not.toBeNull();
    expect(step!.stepIndex).toBe(0);
    expect(step!.question.requestId).toBe("req-1");
    expect(step!.question.questions).toHaveLength(1);
    expect(step!.question.questions[0].id).toBe("q1");
    expect(step!.question.questions[0].options.map((o) => o.label)).toEqual([
      "Apple",
      "Banana",
    ]);
    // Multi-question batches show progress in the body text.
    expect(step!.text).toContain("Which fruit?");
    expect(step!.text).toContain("(1/2)");
  });

  test("returns null once every question is answered", () => {
    registerQuestion("req-1", singleEntry);
    const state = ensureQuestionWizardState("req-1")!;
    recordQuestionTap("req-1", "q1", 0);
    expect(buildQuestionWizardStep(state)).toBeNull();
  });
});

describe("recordQuestionTap", () => {
  test("records an option and completes a one-question batch", () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-1", singleEntry, (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = recordQuestionTap("req-1", "q1", 1);
    expect(result).toMatchObject({ status: "recorded", completed: true });

    // The batch resolved through the shared resolver with the chosen option.
    expect(resolved).toHaveLength(1);
    expect(resolved[0].overall).toBe("completed");
    expect(resolved[0].entries).toEqual([
      { questionId: "q1", decision: "option", optionId: "b" },
    ]);
    // The pending interaction was consumed.
    expect(pendingInteractions.get("req-1")).toBeUndefined();
  });

  test("records a skip and completes", () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-1", singleEntry, (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = recordQuestionTap("req-1", "q1", "skip");
    expect(result).toMatchObject({ status: "recorded", completed: true });
    expect(resolved[0].entries).toEqual([
      { questionId: "q1", decision: "skipped" },
    ]);
  });

  test("advances through a multi-question batch, resolving only at the end", () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-1", twoEntries, (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const first = recordQuestionTap("req-1", "q1", 0);
    expect(first).toMatchObject({ status: "recorded", completed: false });
    expect(resolved).toHaveLength(0);
    expect(pendingInteractions.get("req-1")).toBeDefined();

    // The wizard now shows the second question.
    const state = getQuestionWizardStateByConversation(CONV)!;
    expect(buildQuestionWizardStep(state)!.stepIndex).toBe(1);

    const second = recordQuestionTap("req-1", "q2", 1);
    expect(second).toMatchObject({ status: "recorded", completed: true });
    expect(resolved[0].entries).toEqual([
      { questionId: "q1", decision: "option", optionId: "a" },
      { questionId: "q2", decision: "option", optionId: "l" },
    ]);
  });

  test("index-guards taps for a non-current question", () => {
    registerQuestion("req-1", twoEntries);
    // Current question is q1; a tap for q2 is out of order → stale, no advance.
    expect(recordQuestionTap("req-1", "q2", 0)).toEqual({ status: "stale" });
    const state = getQuestionWizardStateByConversation(CONV)!;
    expect(buildQuestionWizardStep(state)!.stepIndex).toBe(0);
  });

  test("rejects an out-of-range option index as stale", () => {
    registerQuestion("req-1", singleEntry);
    expect(recordQuestionTap("req-1", "q1", 9)).toEqual({ status: "stale" });
    expect(pendingInteractions.get("req-1")).toBeDefined();
  });

  test("returns no_pending for an unregistered requestId", () => {
    expect(recordQuestionTap("nope", "q1", 0)).toEqual({
      status: "no_pending",
    });
  });
});

describe("recordQuestionFreeTextForConversation", () => {
  test("records free text against the current question", () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-1", singleEntry, (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = recordQuestionFreeTextForConversation(CONV, "kiwi");
    expect(result).toMatchObject({ status: "recorded", completed: true });
    expect(resolved[0].entries).toEqual([
      { questionId: "q1", decision: "free_text", text: "kiwi" },
    ]);
  });

  test("mixes free text and taps across a batch", () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-1", twoEntries, (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    recordQuestionFreeTextForConversation(CONV, "mango");
    recordQuestionTap("req-1", "q2", 0);

    expect(resolved[0].entries).toEqual([
      { questionId: "q1", decision: "free_text", text: "mango" },
      { questionId: "q2", decision: "option", optionId: "s" },
    ]);
  });

  test("returns no_pending when no question is parked", () => {
    expect(recordQuestionFreeTextForConversation(CONV, "hi")).toEqual({
      status: "no_pending",
    });
  });
});

describe("buildQuestionWizardSummary", () => {
  test("recaps each answer by label / text after completion", () => {
    registerQuestion("req-1", twoEntries);
    recordQuestionFreeTextForConversation(CONV, "mango");
    recordQuestionTap("req-1", "q2", 1);

    // State lingers until the watcher finalizes; summary reflects the answers.
    const state = getQuestionWizardStateByConversation(CONV)!;
    const summary = buildQuestionWizardSummary(state);
    expect(summary).toContain("mango");
    expect(summary).toContain("Large");
  });

  test("reports an externally-resolved wizard as no longer active", () => {
    registerQuestion("req-1", twoEntries);
    const state = ensureQuestionWizardState("req-1")!;
    // Only the first of two questions answered → incomplete.
    recordQuestionTap("req-1", "q1", 0);
    expect(buildQuestionWizardSummary(state)).toBe(
      "This question is no longer active.",
    );
  });
});

describe("setQuestionWizardMessageTs", () => {
  test("stores the delivered card id for later edits", () => {
    registerQuestion("req-1", singleEntry);
    ensureQuestionWizardState("req-1");
    setQuestionWizardMessageTs("req-1", "555");
    // Round-trips via the conversation lookup the watcher uses.
    expect(getQuestionWizardStateByConversation(CONV)?.messageTs).toBe("555");
  });
});
