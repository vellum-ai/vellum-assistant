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

const { QuestionPrompter } = await import("./question-prompter.js");

function makePrompter() {
  const sent: ServerMessage[] = [];
  const prompter = new QuestionPrompter({
    broadcastMessage: (msg) => sent.push(msg),
  });
  return { prompter, sent };
}

const baseParams = {
  conversationId: "conv-1",
  question: "Pick one",
  options: [
    { id: "a", label: "Apple" },
    { id: "b", label: "Banana" },
  ],
};

describe("QuestionPrompter", () => {
  beforeEach(() => {
    _piStore.clear();
  });

  test("happy path: option resolution", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt(baseParams);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("question_request");

    const requestId = (sent[0] as QuestionRequest).requestId;
    prompter.resolveQuestion(requestId, { kind: "option", optionId: "a" });

    const result = await promise;
    expect(result).toEqual({ decision: "option", optionId: "a" });
    expect(prompter.hasPendingRequest(requestId)).toBe(false);
  });

  test("free-text resolution", async () => {
    const { prompter, sent } = makePrompter();

    const promise = prompter.prompt({
      ...baseParams,
      freeTextPlaceholder: "Type a fruit",
    });

    const req = sent[0] as QuestionRequest;
    expect(req.freeTextPlaceholder).toBe("Type a fruit");

    prompter.resolveQuestion(req.requestId, {
      kind: "free_text",
      text: "Cherry",
    });

    const result = await promise;
    expect(result).toEqual({ decision: "free_text", text: "Cherry" });
  });

  test("timeout fires with decision: timed_out", async () => {
    const { prompter } = makePrompter();
    const result = await prompter.prompt(baseParams);
    expect(result).toEqual({ decision: "timed_out" });
  });

  test("abort signal triggers decision: aborted", async () => {
    const { prompter, sent } = makePrompter();
    const ac = new AbortController();

    const promise = prompter.prompt({ ...baseParams, signal: ac.signal });
    const requestId = (sent[0] as QuestionRequest).requestId;
    expect(prompter.hasPendingRequest(requestId)).toBe(true);

    ac.abort();
    const result = await promise;
    expect(result).toEqual({ decision: "aborted" });
    expect(prompter.hasPendingRequest(requestId)).toBe(false);
  });

  test("pre-aborted signal short-circuits before broadcasting", async () => {
    const { prompter, sent } = makePrompter();
    const ac = new AbortController();
    ac.abort();

    const result = await prompter.prompt({ ...baseParams, signal: ac.signal });
    expect(result).toEqual({ decision: "aborted" });
    expect(sent).toHaveLength(0);
  });
});
