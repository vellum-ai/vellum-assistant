import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  checkSlackEnvelope,
  classifySlackError,
  rawSlackRequest,
  SlackApiError,
} from "./web-api-transport.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Await a promise expected to reject with SlackApiError and return it. */
async function captureSlackApiError(
  promise: Promise<unknown>,
): Promise<SlackApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SlackApiError) {
      return err;
    }
    throw err;
  }
  throw new Error("expected the promise to reject with SlackApiError");
}

describe("SlackApiError", () => {
  test("derives status from category when not explicit", () => {
    expect(new SlackApiError("invalid_auth").status).toBe(401);
    expect(new SlackApiError("token_expired").status).toBe(401);
    expect(new SlackApiError("rate_limited").status).toBe(429);
    expect(new SlackApiError("ratelimited").status).toBe(429);
    expect(new SlackApiError("channel_not_found").status).toBe(400);
    expect(new SlackApiError("invalid_blocks").status).toBe(400);
  });

  test("explicit status wins over the derived one", () => {
    expect(new SlackApiError("http_503", { status: 503 }).status).toBe(503);
  });

  test("normalizes a missing error code to unknown_error", () => {
    const err = new SlackApiError(undefined);
    expect(err.slackError).toBe("unknown_error");
    expect(err.category).toBe("unknown");
    expect(err.message).toBe("Slack API error: unknown_error");
  });

  test("classifies known Slack error codes", () => {
    expect(new SlackApiError("missing_scope").category).toBe("permission");
    expect(new SlackApiError("is_archived").category).toBe("channel_not_found");
    expect(new SlackApiError("message_not_found").category).toBe("not_found");
    expect(classifySlackError("some_new_code")).toBe("unknown");
  });
});

describe("checkSlackEnvelope", () => {
  test("passes ok envelopes through", () => {
    const data = { ok: true as const };
    expect(checkSlackEnvelope(data)).toBe(data);
  });

  test("throws a classified SlackApiError on ok: false", () => {
    expect(() =>
      checkSlackEnvelope({ ok: false, error: "invalid_auth" }),
    ).toThrow(SlackApiError);
    try {
      checkSlackEnvelope({ ok: false, error: "invalid_auth" });
    } catch (err) {
      expect((err as SlackApiError).status).toBe(401);
      expect((err as SlackApiError).category).toBe("auth");
    }
  });
});

describe("rawSlackRequest", () => {
  test("retries HTTP 429 honoring Retry-After, then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const data = await rawSlackRequest("xoxb-t", "conversations.info", {
      query: { channel: "C1" },
    });
    expect(data.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("retries 5xx and reports SlackApiError after exhausting retries", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;

    // The fixed 1s backoff between 5xx retries is real time, so this test
    // runs ~3s (3 retries); the timeout below gives it headroom.
    const promise = rawSlackRequest("xoxb-t", "chat.postMessage", {
      body: { channel: "C1", text: "hi" },
    });
    const err = await captureSlackApiError(promise);
    expect(err.status).toBe(503);
    expect(err.slackError).toBe("http_503");
    expect(calls).toBe(4);
  }, 10_000);

  test("throws classified SlackApiError for non-retryable envelope errors", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ ok: false, error: "channel_not_found" }),
    ) as unknown as typeof fetch;

    const promise = rawSlackRequest("xoxb-t", "conversations.info", {
      query: { channel: "C_MISSING" },
    });
    const err = await captureSlackApiError(promise);
    expect(err.category).toBe("channel_not_found");
  });

  test("throws http_<status> SlackApiError for non-JSON 4xx responses", async () => {
    globalThis.fetch = mock(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;

    const promise = rawSlackRequest("xoxb-t", "conversations.info", {});
    const err = await captureSlackApiError(promise);
    expect(err.status).toBe(403);
    expect(err.slackError).toBe("http_403");
  });

  test("rejects form bodies dispatched over an OAuth connection", async () => {
    const connection = {
      request: async () => {
        throw new Error("connection.request must not be reached for forms");
      },
      withToken: async () => {
        throw new Error("withToken must not be reached for forms");
      },
    };
    const { slackRequest } = await import("./web-api-transport.js");
    const err = await captureSlackApiError(
      slackRequest(connection as never, "files.getUploadURLExternal", {
        form: new URLSearchParams({ filename: "a.png" }),
      }),
    );
    expect(err.slackError).toBe("form_unsupported_over_oauth");
  });

  test("sends form bodies as x-www-form-urlencoded POSTs", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      capturedInit = init;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await rawSlackRequest("xoxb-t", "files.getUploadURLExternal", {
      form: new URLSearchParams({ filename: "a.png", length: "10" }),
    });
    expect(capturedInit?.method).toBe("POST");
    expect(
      (capturedInit?.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/x-www-form-urlencoded");
  });
});
