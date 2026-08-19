/**
 * Tests for the conversation-scoped shape of `GET /v1/pending-interactions`.
 *
 * The registry is the authority clients project their prompt UI from, so what
 * this route says about a kind matters as much when nothing is outstanding as
 * when something is. Covers:
 *   - an outstanding question is reported with its full batch,
 *   - no question reports `null` (the value that authorizes a client to retire
 *     a card), not an omitted key,
 *   - every conversation-scoped path names the key, including the early return
 *     for a conversation that cannot be resolved,
 *   - the newest question wins while a superseded one is still settling,
 *   - a question registered without entries is not reportable,
 *   - the diagnostic (unfiltered) mode is unchanged.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { QuestionEntry } from "../../../api/events/question-request.js";
import * as pendingInteractions from "../../pending-interactions.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// The conversation-key lookup is the only path into the unresolvable-conversation
// early return, and it reads SQLite. Stub it so this stays a unit test of the
// response shape. Imported dynamically below so the stub is in place first.
mock.module("../../../persistence/conversation-key-store.js", () => ({
  getConversationByKey: () => undefined,
}));

const { ROUTES: APPROVAL_ROUTES } = await import("../approval-routes.js");

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = APPROVAL_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const handler = findHandler("pending_interactions");

interface ScopedResponse {
  pendingConfirmation: unknown;
  pendingSecret: unknown;
  pendingQuestion: { requestId: string; entries: QuestionEntry[] } | null;
}

async function listForConversation(
  conversationId: string,
): Promise<ScopedResponse> {
  const result = await handler({
    queryParams: { conversationId },
  } as unknown as RouteHandlerArgs);
  return result as ScopedResponse;
}

const ENTRIES: QuestionEntry[] = [
  {
    id: "q1",
    question: "Which draft should I send?",
    options: [
      { id: "a", label: "The short one" },
      { id: "b", label: "The long one" },
    ],
  },
];

function registerQuestion(requestId: string, entries = ENTRIES): void {
  pendingInteractions.register(requestId, {
    conversationId: "conv-1",
    kind: "question",
    toolUseId: `tool-${requestId}`,
    questionDetails: { entries },
  });
}

/** A question interaction that never got its batch attached. */
function registerQuestionWithoutDetails(requestId: string): void {
  pendingInteractions.register(requestId, {
    conversationId: "conv-1",
    kind: "question",
    toolUseId: `tool-${requestId}`,
  });
}

afterEach(() => {
  pendingInteractions.clear();
});

describe("pending-interactions, conversation-scoped", () => {
  test("reports an outstanding question with its full batch", async () => {
    // GIVEN a question interaction awaiting an answer in the conversation
    registerQuestion("req-1");

    // WHEN the conversation's pending interactions are read
    const result = await listForConversation("conv-1");

    // THEN the prompt is reported with everything the card needs to render
    expect(result.pendingQuestion).toEqual({
      requestId: "req-1",
      entries: ENTRIES,
    });
  });

  test("reports null once the question is resolved", async () => {
    // GIVEN a question that has since been answered (registry entry consumed)
    registerQuestion("req-1");
    pendingInteractions.resolve("req-1", "answered");

    // WHEN the conversation's pending interactions are read
    const result = await listForConversation("conv-1");

    // THEN the answer is a positive "nothing outstanding", which is what lets a
    // client retire a card it is still showing. An omitted key would instead
    // read as "this assistant has no opinion" and strand the card.
    expect(result.pendingQuestion).toBeNull();
    expect("pendingQuestion" in result).toBe(true);
  });

  test("names the key even when the conversation cannot be resolved", async () => {
    // GIVEN a conversationKey that maps to no conversation
    const result = (await handler({
      queryParams: { conversationKey: "no-such-key" },
    } as unknown as RouteHandlerArgs)) as ScopedResponse;

    // THEN the early return still states all three kinds, so this path is not
    // mistaken for an assistant that predates the field
    expect("pendingQuestion" in result).toBe(true);
    expect(result.pendingQuestion).toBeNull();
  });

  test("reports the newest question while a superseded one settles", async () => {
    // GIVEN a superseded prompt that has not finished settling through its
    // abort signal, so both entries sit in the registry at once
    const newerEntries: QuestionEntry[] = [
      { id: "q1", question: "Actually, which account?", options: [] },
    ];
    registerQuestion("req-old");
    registerQuestion("req-new", newerEntries);

    // WHEN the conversation's pending interactions are read
    const result = await listForConversation("conv-1");

    // THEN the prompt the user is actually being asked is the one reported
    expect(result.pendingQuestion?.requestId).toBe("req-new");
  });

  test("does not report a question registered without its entries", async () => {
    // GIVEN a question interaction carrying no renderable batch
    registerQuestionWithoutDetails("req-1");

    // WHEN the conversation's pending interactions are read
    const result = await listForConversation("conv-1");

    // THEN there is nothing a client could raise
    expect(result.pendingQuestion).toBeNull();
  });

  test("leaves the unfiltered diagnostic listing unchanged", async () => {
    // GIVEN pending interactions across the daemon
    registerQuestion("req-1");

    // WHEN the route is called with no conversation filter
    const result = (await handler({
      queryParams: {},
    } as unknown as RouteHandlerArgs)) as {
      interactions: Array<{ requestId: string; kind: string }>;
    };

    // THEN it still answers with the flat cross-conversation list
    expect(result.interactions).toEqual([
      expect.objectContaining({ requestId: "req-1", kind: "question" }),
    ]);
  });
});
