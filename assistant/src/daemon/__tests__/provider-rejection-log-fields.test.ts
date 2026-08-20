/**
 * Tests that an unclassified 4xx provider rejection logs the upstream
 * response body (bounded) plus the offending request content-part coordinates,
 * so the failing message can be identified from the daemon log alone.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../../api/index.js";
import { ProviderError } from "../../util/errors.js";
import * as loggerModule from "../../util/logger.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../conversation-agent-loop-handlers.js";
import {
  buildProviderRejectionLogFields,
  MAX_LOGGED_UPSTREAM_BODY_CHARS,
} from "../provider-rejection-log-fields.js";

const logRecords: Record<string, unknown>[] = [];

mock.module("../../util/logger.js", () => ({
  ...loggerModule,
  getLogger: () => ({
    error: (record: Record<string, unknown>) => {
      logRecords.push(record);
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  }),
}));

// The handlers module binds its logger at import time, so it is loaded
// dynamically once the logger stub is installed above.
const { createEventHandlerState, dispatchAgentEvent } =
  await import("../conversation-agent-loop-handlers.js");

function createDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: "conv-provider-rejection",
      provider: { name: "openai" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (_msg: AssistantEvent) => {},
    reqId: "req-provider-rejection",
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

describe("buildProviderRejectionLogFields", () => {
  test("carries the verbatim upstream body", () => {
    // GIVEN a provider rejection that captured the upstream 400 body
    const rawBody = JSON.stringify({
      error: {
        message: "Invalid body: failed to parse JSON value from the request.",
        type: "invalid_request_error",
        code: "invalid_body",
      },
    });
    const error = new ProviderError(
      "API error (400): Invalid body",
      "openai",
      400,
      {
        rawBody,
        apiErrorCode: "invalid_body",
        apiErrorType: "invalid_request_error",
        requestId: "req_abc123",
      },
    );

    // WHEN diagnostic log fields are built for it
    const fields = buildProviderRejectionLogFields(error);

    // THEN the body and the upstream metadata ride the record
    expect(fields.upstreamErrorBody).toBe(rawBody);
    expect(fields.upstreamErrorBodyTruncated).toBeUndefined();
    expect(fields.apiErrorCode).toBe("invalid_body");
    expect(fields.apiErrorType).toBe("invalid_request_error");
    expect(fields.requestId).toBe("req_abc123");
  });

  test("bounds the body to 4 KB and flags the truncation", () => {
    // GIVEN an upstream body larger than the logged ceiling
    const rawBody = "x".repeat(MAX_LOGGED_UPSTREAM_BODY_CHARS + 500);
    const error = new ProviderError("API error (400): huge", "openai", 400, {
      rawBody,
    });

    // WHEN diagnostic log fields are built for it
    const fields = buildProviderRejectionLogFields(error);

    // THEN the logged body stops at the ceiling
    expect(fields.upstreamErrorBody).toHaveLength(
      MAX_LOGGED_UPSTREAM_BODY_CHARS,
    );
    // AND the record says the body was cut
    expect(fields.upstreamErrorBodyTruncated).toBe(true);
  });

  test("parses the offending content-part coordinates for oversized strings", () => {
    // GIVEN an oversized-content-part rejection naming the request position
    const error = new ProviderError(
      "API error (400): Invalid 'input[191].content[1].text': string too long. Expected a string with maximum length 10485760, but got a string with length 11436754 instead.",
      "openai",
      400,
      { apiErrorCode: "string_above_max_length" },
    );

    // WHEN diagnostic log fields are built for it
    const fields = buildProviderRejectionLogFields(error);

    // THEN the message and content indices are logged for a follow-up query
    expect(fields.offendingMessageIndex).toBe(191);
    expect(fields.offendingContentIndex).toBe(1);
  });

  test("parses coordinates out of the Chat Completions `messages[N]` shape", () => {
    // GIVEN a rejection using the Chat Completions request shape
    const error = new ProviderError(
      "API error (400): Invalid 'messages[7].content[0].text': string too long.",
      "openai",
      400,
      { apiErrorCode: "string_above_max_length" },
    );

    // WHEN diagnostic log fields are built for it
    const fields = buildProviderRejectionLogFields(error);

    // THEN the same coordinates are extracted
    expect(fields.offendingMessageIndex).toBe(7);
    expect(fields.offendingContentIndex).toBe(0);
  });

  test("leaves coordinates absent for codes that carry no content-part pointer", () => {
    // GIVEN a rejection whose code is outside the narrow tap
    const error = new ProviderError(
      "API error (400): Invalid 'input[3].content[0].text': something else.",
      "openai",
      400,
      { apiErrorCode: "model_not_found" },
    );

    // WHEN diagnostic log fields are built for it
    const fields = buildProviderRejectionLogFields(error);

    // THEN no coordinates are inferred from a coincidental match
    expect(fields.offendingMessageIndex).toBeUndefined();
    expect(fields.offendingContentIndex).toBeUndefined();
  });

  test("scrubs secrets out of the upstream body", () => {
    // GIVEN an upstream body that echoed back a credential
    const projectKey = `sk-proj-${"A".repeat(48)}`;
    const error = new ProviderError("API error (400): bad key", "openai", 400, {
      rawBody: JSON.stringify({
        error: { message: `Incorrect API key provided: ${projectKey}` },
        headers: { authorization: "Bearer some-token-value" },
      }),
    });

    // WHEN diagnostic log fields are built for it
    const fields = buildProviderRejectionLogFields(error);

    // THEN the credential never reaches the log record
    expect(fields.upstreamErrorBody).not.toContain(projectKey);
    expect(fields.upstreamErrorBody).not.toContain("some-token-value");
    expect(fields.upstreamErrorBody).toContain("[REDACTED]");
  });

  test("reports a null body for errors that are not provider errors", () => {
    // GIVEN a non-provider error
    const error = new Error("socket hang up");

    // WHEN diagnostic log fields are built for it
    const fields = buildProviderRejectionLogFields(error);

    // THEN the body is explicitly null rather than missing
    expect(fields.upstreamErrorBody).toBeNull();
  });
});

describe("unclassified 4xx log line", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    logRecords.length = 0;
    state = createEventHandlerState();
  });

  test("includes the upstream response body", async () => {
    // GIVEN an unclassified 4xx provider rejection carrying the upstream body
    const rawBody = JSON.stringify({
      error: {
        message:
          "Invalid body: failed to parse JSON value from the request. Common errors include trailing commas.",
        type: "invalid_request_error",
        code: "invalid_body",
      },
    });
    const error = new ProviderError(
      "API error (400): Invalid body: failed to parse JSON value from the request.",
      "openai",
      400,
      { rawBody, apiErrorCode: "invalid_body" },
    );

    // WHEN the agent loop dispatches the error event
    await dispatchAgentEvent(state, createDeps(), { type: "error", error });

    // THEN the log record carries the body alongside the existing fields
    const record = logRecords.find((r) => r.upstreamErrorBody !== undefined);
    expect(record).toBeDefined();
    expect(record?.upstreamErrorBody).toBe(rawBody);
    expect(record?.conversationId).toBe("conv-provider-rejection");
    expect(record?.statusCode).toBe(400);
    expect(record?.provider).toBe("openai");
  });

  test("scrubs secrets out of the error message it logs", async () => {
    // GIVEN a rejection whose normalized message echoes a credential
    const error = new ProviderError(
      "API error (400): rejected request with Authorization: Bearer some-token-value",
      "openai",
      400,
      { rawBody: "{}" },
    );

    // WHEN the agent loop dispatches the error event
    await dispatchAgentEvent(state, createDeps(), { type: "error", error });

    // THEN the credential is redacted out of the logged message
    const record = logRecords.find((r) => r.upstreamErrorBody !== undefined);
    expect(record?.errorMessage).not.toContain("some-token-value");
    expect(record?.errorMessage).toContain("Bearer [REDACTED]");
  });

  test("bounds a huge upstream body to 4 KB", async () => {
    // GIVEN an unclassified 4xx rejection whose body exceeds the ceiling
    const error = new ProviderError("API error (400): huge", "openai", 400, {
      rawBody: "y".repeat(MAX_LOGGED_UPSTREAM_BODY_CHARS * 3),
    });

    // WHEN the agent loop dispatches the error event
    await dispatchAgentEvent(state, createDeps(), { type: "error", error });

    // THEN the logged body is capped
    const record = logRecords.find((r) => r.upstreamErrorBody !== undefined);
    expect(record?.upstreamErrorBody).toHaveLength(
      MAX_LOGGED_UPSTREAM_BODY_CHARS,
    );
    expect(record?.upstreamErrorBodyTruncated).toBe(true);
  });
});
