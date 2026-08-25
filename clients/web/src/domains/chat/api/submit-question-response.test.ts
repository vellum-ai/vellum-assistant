/**
 * Which wire shape `submitQuestionResponse` posts, and what each one carries.
 *
 * The answer the user gave has to survive the trip: the batched shape can say
 * a question was skipped, the legacy single-question shape cannot, and the
 * assistant's version decides which one it is sent. A skip that leaves as
 * blank free text is recorded as an empty typed answer and read by the model
 * as one, so the shape choice is the answer's fidelity, not a formality.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { submitQuestionResponse } from "@/domains/chat/api/interactions";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-1";
const REQUEST_ID = "req-1";

let originalFetch: typeof fetch;
let originalDocument: unknown;
let capturedBodies: unknown[] = [];

function seedVersion(version: string | null): void {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, ASSISTANT_ID);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  capturedBodies = [];
  useAssistantIdentityStore.getState().clearIdentity();
  // The daemon client's request interceptor reads `document.cookie` on
  // mutating requests; the bun test environment has no document.
  originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    cookie: "csrftoken=test",
  };
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      let bodyText: string | undefined;
      if (input instanceof Request) {
        bodyText = await input.clone().text();
      } else if (typeof init?.body === "string") {
        bodyText = init.body;
      }
      // Only the answer POST, so an unrelated request cannot pass for one.
      if (url.includes("question-response")) {
        capturedBodies.push(JSON.parse(bodyText ?? "{}"));
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useAssistantIdentityStore.getState().clearIdentity();
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

describe("submitQuestionResponse against an assistant with the batched route", () => {
  beforeEach(() => {
    seedVersion("0.11.4");
  });

  test("posts a one-entry answer batched", async () => {
    await submitQuestionResponse(ASSISTANT_ID, REQUEST_ID, {
      kind: "submit",
      responses: [{ questionId: "q1", kind: "option", optionId: "opt-a" }],
    });

    expect(capturedBodies).toEqual([
      {
        requestId: REQUEST_ID,
        kind: "submit",
        responses: [{ questionId: "q1", kind: "option", optionId: "opt-a" }],
      },
    ]);
  });

  test("keeps a lone skip a skip", async () => {
    await submitQuestionResponse(ASSISTANT_ID, REQUEST_ID, {
      kind: "submit",
      responses: [{ questionId: "q1", kind: "skip" }],
    });

    expect(capturedBodies).toEqual([
      {
        requestId: REQUEST_ID,
        kind: "submit",
        responses: [{ questionId: "q1", kind: "skip" }],
      },
    ]);
  });

  test("posts a close as a close", async () => {
    await submitQuestionResponse(ASSISTANT_ID, REQUEST_ID, { kind: "close" });

    expect(capturedBodies).toEqual([{ requestId: REQUEST_ID, kind: "close" }]);
  });
});

describe("submitQuestionResponse against an assistant without the batched route", () => {
  beforeEach(() => {
    seedVersion("0.8.1");
  });

  test("downgrades a one-entry answer to the legacy shape", async () => {
    await submitQuestionResponse(ASSISTANT_ID, REQUEST_ID, {
      kind: "submit",
      responses: [{ questionId: "q1", kind: "option", optionId: "opt-a" }],
    });

    expect(capturedBodies).toEqual([
      { requestId: REQUEST_ID, kind: "option", optionId: "opt-a" },
    ]);
  });

  test("carries a lone skip as blank free text, which the shape cannot say better", async () => {
    await submitQuestionResponse(ASSISTANT_ID, REQUEST_ID, {
      kind: "submit",
      responses: [{ questionId: "q1", kind: "skip" }],
    });

    expect(capturedBodies).toEqual([
      { requestId: REQUEST_ID, kind: "free_text", text: "" },
    ]);
  });

  test("still batches a multi-entry answer, which the legacy shape cannot express", async () => {
    await submitQuestionResponse(ASSISTANT_ID, REQUEST_ID, {
      kind: "submit",
      responses: [
        { questionId: "q1", kind: "option", optionId: "opt-a" },
        { questionId: "q2", kind: "skip" },
      ],
    });

    expect(capturedBodies).toEqual([
      {
        requestId: REQUEST_ID,
        kind: "submit",
        responses: [
          { questionId: "q1", kind: "option", optionId: "opt-a" },
          { questionId: "q2", kind: "skip" },
        ],
      },
    ]);
  });
});
