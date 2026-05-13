import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  QuestionRequest,
  ServerMessage,
} from "../daemon/message-protocol.js";

// Use a tiny timeout so the setTimeout branch fires quickly in tests
const mockConfig = {
  timeouts: { permissionTimeoutSec: 0.05 },
};
mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

// Use a real Map so QuestionPrompter can store and retrieve callbacks.
const _piStore = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
mock.module("../runtime/pending-interactions.js", () => ({
  register: (id: string, entry: object) => _piStore.set(id, entry),
  resolve: (id: string) => {
    const e = _piStore.get(id);
    if (e?.timer != null) clearTimeout(e.timer);
    _piStore.delete(id);
    return e;
  },
  get: (id: string) => _piStore.get(id),
  getAll: () => [..._piStore.values()],
  getByConversation: () => [],
  getByKind: () => [],
  removeByConversation: () => {},
  clear: () => _piStore.clear(),
}));

const { QuestionPrompter, QuestionBatchValidationError } = await import(
  "./question-prompter.js"
);

function makePrompter() {
  const sent: ServerMessage[] = [];
  const prompter = new QuestionPrompter({
    broadcastMessage: (msg) => sent.push(msg),
  });
  return { prompter, sent };
}

const fruitOptions = [
  { id: "a", label: "Apple" },
  { id: "b", label: "Banana" },
];

const singleQuestionParams = {
  conversationId: "conv-1",
  questions: [
    {
      question: "Pick one",
      options: fruitOptions,
    },
  ],
};

const threeQuestionParams = {
  conversationId: "conv-1",
  questions: [
    { question: "Q1?", options: fruitOptions },
    {
      question: "Q2?",
      options: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
    },
    {
      question: "Q3?",
      options: [
        { id: "p", label: "P" },
        { id: "q", label: "Q" },
      ],
      freeTextPlaceholder: "or type",
    },
  ],
};

describe("QuestionPrompter", () => {
  beforeEach(() => {
    _piStore.clear();
  });

  test("happy path: option resolution via submitQuestionBatch", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(singleQuestionParams);

    expect(sent).toHaveLength(1);
    const req = sent[0] as QuestionRequest;
    expect(req.type).toBe("question_request");
    expect(req.questions).toHaveLength(1);
    expect(req.questions[0]?.id).toBe("q1");

    prompter.submitQuestionBatch(req.requestId, [
      { questionId: "q1", kind: "option", optionId: "a" },
    ]);

    const result = await promise;
    expect(result).toEqual({
      entries: [{ questionId: "q1", decision: "option", optionId: "a" }],
      overall: "completed",
    });
    expect(prompter.hasPendingRequest(req.requestId)).toBe(false);
  });

  test("free-text resolution", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt({
      conversationId: "conv-1",
      questions: [
        {
          question: "Pick one",
          options: fruitOptions,
          freeTextPlaceholder: "Type a fruit",
        },
      ],
    });

    const req = sent[0] as QuestionRequest;
    expect(req.freeTextPlaceholder).toBe("Type a fruit");
    expect(req.questions[0]?.freeTextPlaceholder).toBe("Type a fruit");

    prompter.submitQuestionBatch(req.requestId, [
      { questionId: "q1", kind: "free_text", text: "Cherry" },
    ]);

    const result = await promise;
    expect(result).toEqual({
      entries: [{ questionId: "q1", decision: "free_text", text: "Cherry" }],
      overall: "completed",
    });
  });

  test("batched broadcast: assigns sequential q1..qN ids and mirrors questions[0] in flat fields", async () => {
    const { prompter, sent } = makePrompter();

    void prompter.prompt(threeQuestionParams);

    expect(sent).toHaveLength(1);
    const req = sent[0] as QuestionRequest;
    expect(req.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    // Flat fields mirror the first entry for backwards compat.
    expect(req.question).toBe("Q1?");
    expect(req.options).toEqual(fruitOptions);
  });

  test("three-question batch: two options + one free-text → ordered entries", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(threeQuestionParams);
    const req = sent[0] as QuestionRequest;

    prompter.submitQuestionBatch(req.requestId, [
      { questionId: "q2", kind: "option", optionId: "y" },
      { questionId: "q1", kind: "option", optionId: "a" },
      { questionId: "q3", kind: "free_text", text: "noon-ish" },
    ]);

    const result = await promise;
    expect(result.overall).toBe("completed");
    // Result entries are in the original questions[] order, regardless of
    // the order submissions arrive in.
    expect(result.entries).toEqual([
      { questionId: "q1", decision: "option", optionId: "a" },
      { questionId: "q2", decision: "option", optionId: "y" },
      { questionId: "q3", decision: "free_text", text: "noon-ish" },
    ]);
  });

  test("three-question batch: all skipped via submitQuestionBatch", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(threeQuestionParams);
    const req = sent[0] as QuestionRequest;

    prompter.submitQuestionBatch(req.requestId, [
      { questionId: "q1", kind: "skip" },
      { questionId: "q2", kind: "skip" },
      { questionId: "q3", kind: "skip" },
    ]);

    const result = await promise;
    expect(result.overall).toBe("completed");
    expect(result.entries.every((e) => e.decision === "skipped")).toBe(true);
  });

  test("closeQuestion: all entries skipped with overall=closed", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(threeQuestionParams);
    const req = sent[0] as QuestionRequest;

    prompter.closeQuestion(req.requestId);

    const result = await promise;
    expect(result.overall).toBe("closed");
    expect(result.entries).toEqual([
      { questionId: "q1", decision: "skipped" },
      { questionId: "q2", decision: "skipped" },
      { questionId: "q3", decision: "skipped" },
    ]);
  });

  test("submitQuestionBatch rejects unknown questionId", async () => {
    const { prompter, sent } = makePrompter();
    void prompter.prompt(singleQuestionParams);
    const req = sent[0] as QuestionRequest;

    expect(() =>
      prompter.submitQuestionBatch(req.requestId, [
        { questionId: "qX", kind: "option", optionId: "a" },
      ]),
    ).toThrow(QuestionBatchValidationError);
  });

  test("submitQuestionBatch rejects missing entry", async () => {
    const { prompter, sent } = makePrompter();
    void prompter.prompt(threeQuestionParams);
    const req = sent[0] as QuestionRequest;

    expect(() =>
      prompter.submitQuestionBatch(req.requestId, [
        { questionId: "q1", kind: "option", optionId: "a" },
        { questionId: "q2", kind: "option", optionId: "x" },
      ]),
    ).toThrow(QuestionBatchValidationError);
  });

  test("submitQuestionBatch rejects unknown optionId", async () => {
    const { prompter, sent } = makePrompter();
    void prompter.prompt(singleQuestionParams);
    const req = sent[0] as QuestionRequest;

    expect(() =>
      prompter.submitQuestionBatch(req.requestId, [
        { questionId: "q1", kind: "option", optionId: "nope" },
      ]),
    ).toThrow(QuestionBatchValidationError);
  });

  test("timeout fires with overall: timed_out and timed_out entries", async () => {
    const { prompter } = makePrompter();
    const result = await prompter.prompt(threeQuestionParams);
    expect(result.overall).toBe("timed_out");
    expect(result.entries).toEqual([
      { questionId: "q1", decision: "timed_out" },
      { questionId: "q2", decision: "timed_out" },
      { questionId: "q3", decision: "timed_out" },
    ]);
  });

  test("abort signal triggers overall: aborted", async () => {
    const { prompter, sent } = makePrompter();
    const ac = new AbortController();

    const promise = prompter.prompt({
      ...threeQuestionParams,
      signal: ac.signal,
    });
    const req = sent[0] as QuestionRequest;
    expect(prompter.hasPendingRequest(req.requestId)).toBe(true);

    ac.abort();
    const result = await promise;
    expect(result.overall).toBe("aborted");
    expect(prompter.hasPendingRequest(req.requestId)).toBe(false);
  });

  test("pre-aborted signal short-circuits before broadcasting", async () => {
    const { prompter, sent } = makePrompter();
    const ac = new AbortController();
    ac.abort();

    const result = await prompter.prompt({
      ...threeQuestionParams,
      signal: ac.signal,
    });
    expect(result.overall).toBe("aborted");
    expect(sent).toHaveLength(0);
  });
});
