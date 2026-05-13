import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  QuestionRequest,
  ServerMessage,
} from "../daemon/message-protocol.js";
import type {
  QuestionBatchSubmission,
  QuestionPromptResult,
} from "./question-prompter.js";

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
interface MockInteraction {
  rpcResolve?: (v: unknown) => void;
  rpcReject?: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  metadata?: {
    orderedIds: string[];
    optionsById: Record<string, string[]>;
  };
}
const _piStore = new Map<string, MockInteraction>();
mock.module("../runtime/pending-interactions.js", () => ({
  register: (id: string, entry: MockInteraction) => _piStore.set(id, entry),
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

const {
  QuestionPrompter,
  QuestionBatchValidationError,
  buildBatchEntries,
} = await import("./question-prompter.js");

function makePrompter() {
  const sent: ServerMessage[] = [];
  const prompter = new QuestionPrompter({
    broadcastMessage: (msg) => sent.push(msg),
  });
  return { prompter, sent };
}

/**
 * Drive a pending question interaction the same way the
 * `/v1/question-response` route does: look up the metadata, run
 * `buildBatchEntries`, deregister, then fire `rpcResolve`. Centralizing the
 * sequence in one helper keeps the tests focused on observable behavior and
 * mirrors the production resolution path.
 */
function resolveBatch(
  requestId: string,
  submissions: QuestionBatchSubmission[],
): QuestionPromptResult {
  const interaction = _piStore.get(requestId);
  if (!interaction?.metadata) {
    throw new Error(`No pending question interaction for ${requestId}`);
  }
  const { orderedIds, optionsById } = interaction.metadata;
  const entries = buildBatchEntries(
    orderedIds,
    (qid, oid) => (optionsById[qid] ?? []).includes(oid),
    new Set(Object.keys(optionsById)),
    submissions,
  );
  const result: QuestionPromptResult = { entries, overall: "completed" };
  if (interaction.timer != null) clearTimeout(interaction.timer);
  _piStore.delete(requestId);
  interaction.rpcResolve?.(result);
  return result;
}

/**
 * Close a pending question card: every entry reported as `skipped`, overall
 * status `closed`. Mirrors the route's `kind: "close"` branch.
 */
function closeBatch(requestId: string): QuestionPromptResult {
  const interaction = _piStore.get(requestId);
  if (!interaction?.metadata) {
    throw new Error(`No pending question interaction for ${requestId}`);
  }
  const result: QuestionPromptResult = {
    entries: interaction.metadata.orderedIds.map((id) => ({
      questionId: id,
      decision: "skipped" as const,
    })),
    overall: "closed",
  };
  if (interaction.timer != null) clearTimeout(interaction.timer);
  _piStore.delete(requestId);
  interaction.rpcResolve?.(result);
  return result;
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

  test("happy path: option resolution via the shared batch helpers", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(singleQuestionParams);

    expect(sent).toHaveLength(1);
    const req = sent[0] as QuestionRequest;
    expect(req.type).toBe("question_request");
    expect(req.questions).toHaveLength(1);
    expect(req.questions[0]?.id).toBe("q1");

    resolveBatch(req.requestId, [
      { questionId: "q1", kind: "option", optionId: "a" },
    ]);

    const result = await promise;
    expect(result).toEqual({
      entries: [{ questionId: "q1", decision: "option", optionId: "a" }],
      overall: "completed",
    });
    expect(_piStore.has(req.requestId)).toBe(false);
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

    resolveBatch(req.requestId, [
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

    resolveBatch(req.requestId, [
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

  test("three-question batch: all skipped via submitted entries", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(threeQuestionParams);
    const req = sent[0] as QuestionRequest;

    resolveBatch(req.requestId, [
      { questionId: "q1", kind: "skip" },
      { questionId: "q2", kind: "skip" },
      { questionId: "q3", kind: "skip" },
    ]);

    const result = await promise;
    expect(result.overall).toBe("completed");
    expect(result.entries.every((e) => e.decision === "skipped")).toBe(true);
  });

  test("close path: all entries skipped with overall=closed", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(threeQuestionParams);
    const req = sent[0] as QuestionRequest;

    closeBatch(req.requestId);

    const result = await promise;
    expect(result.overall).toBe("closed");
    expect(result.entries).toEqual([
      { questionId: "q1", decision: "skipped" },
      { questionId: "q2", decision: "skipped" },
      { questionId: "q3", decision: "skipped" },
    ]);
  });

  test("buildBatchEntries rejects unknown questionId", () => {
    expect(() =>
      buildBatchEntries(
        ["q1"],
        () => true,
        new Set(["q1"]),
        [{ questionId: "qX", kind: "option", optionId: "a" }],
      ),
    ).toThrow(QuestionBatchValidationError);
  });

  test("buildBatchEntries rejects missing entry", () => {
    expect(() =>
      buildBatchEntries(
        ["q1", "q2", "q3"],
        () => true,
        new Set(["q1", "q2", "q3"]),
        [
          { questionId: "q1", kind: "option", optionId: "a" },
          { questionId: "q2", kind: "option", optionId: "x" },
        ],
      ),
    ).toThrow(QuestionBatchValidationError);
  });

  test("buildBatchEntries rejects unknown optionId", () => {
    expect(() =>
      buildBatchEntries(
        ["q1"],
        (qid, oid) => qid === "q1" && (oid === "a" || oid === "b"),
        new Set(["q1"]),
        [{ questionId: "q1", kind: "option", optionId: "nope" }],
      ),
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

  test("abort signal triggers overall: aborted with per-entry aborted decisions", async () => {
    const { prompter, sent } = makePrompter();
    const ac = new AbortController();

    const promise = prompter.prompt({
      ...threeQuestionParams,
      signal: ac.signal,
    });
    const req = sent[0] as QuestionRequest;
    expect(_piStore.has(req.requestId)).toBe(true);

    ac.abort();
    const result = await promise;
    expect(result.overall).toBe("aborted");
    expect(result.entries).toEqual([
      { questionId: "q1", decision: "aborted" },
      { questionId: "q2", decision: "aborted" },
      { questionId: "q3", decision: "aborted" },
    ]);
    expect(_piStore.has(req.requestId)).toBe(false);
  });

  test("pre-aborted signal short-circuits before broadcasting with aborted entries", async () => {
    const { prompter, sent } = makePrompter();
    const ac = new AbortController();
    ac.abort();

    const result = await prompter.prompt({
      ...threeQuestionParams,
      signal: ac.signal,
    });
    expect(result.overall).toBe("aborted");
    expect(result.entries).toEqual([
      { questionId: "q1", decision: "aborted" },
      { questionId: "q2", decision: "aborted" },
      { questionId: "q3", decision: "aborted" },
    ]);
    expect(sent).toHaveLength(0);
  });
});
