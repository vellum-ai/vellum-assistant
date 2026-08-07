import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock logger ──────────────────────────────────────────────────────────────

// ── Mock sleep so retry tests don't slow down the suite ──────────────────────

mock.module("../util/retry.js", () => ({
  sleep: async (_ms: number): Promise<void> => {},
  isRetryableStatus: (status: number): boolean =>
    status === 429 || status >= 500,
  isRetryableNetworkError: (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      return false;
    }
    const codes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);
    const code = (error as { code?: string }).code;
    if (code && codes.has(code)) {
      return true;
    }
    if (error.cause instanceof Error) {
      const causeCode = (error.cause as { code?: string }).code;
      if (causeCode && codes.has(causeCode)) {
        return true;
      }
    }
    return false;
  },
}));

// ── VellumPlatformClient mock state ──────────────────────────────────────────

interface FetchCall {
  path: string;
  method: string;
  body: Record<string, unknown>;
  hasAbortSignal: boolean;
}

const fetchCalls: FetchCall[] = [];
const fetchResponses: Array<{ ok: boolean; status: number; body?: string }> =
  [];
const fetchErrors: Error[] = [];
let clientAvailable = true;

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => {
      if (!clientAvailable) {
        return null;
      }
      return {
        platformAssistantId: "test-assistant-id",
        fetch: async (path: string, init?: RequestInit) => {
          const body = init?.body
            ? (JSON.parse(init.body as string) as Record<string, unknown>)
            : {};
          fetchCalls.push({
            path,
            method: init?.method ?? "GET",
            body,
            hasAbortSignal: init?.signal instanceof AbortSignal,
          });
          const error = fetchErrors.shift();
          if (error) {
            throw error;
          }
          const response = fetchResponses.shift() ?? {
            ok: true,
            status: 200,
            body: "{}",
          };
          return {
            ok: response.ok,
            status: response.status,
            text: async () => response.body ?? "",
            json: async () => JSON.parse(response.body ?? "") as unknown,
          };
        },
      };
    },
  },
}));

import { PlatformPushAdapter } from "../notifications/adapters/platform.js";
import type {
  ChannelDeliveryPayload,
  ChannelDestination,
} from "../notifications/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePayload(
  overrides?: Partial<ChannelDeliveryPayload>,
): ChannelDeliveryPayload {
  return {
    deliveryId: "delivery-uuid-1",
    correlationId: "signal-1",
    sourceEventName: "schedule.notify",
    copy: { title: "Reminder", body: "Check the oven!" },
    deepLinkTarget: { type: "conversation", id: "conv-1" },
    contextPayload: { jobId: "job-1" },
    urgency: "medium",
    ...overrides,
  };
}

function makeDestination(
  overrides?: Partial<ChannelDestination>,
): ChannelDestination {
  return {
    channel: "platform",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PlatformPushAdapter", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    fetchResponses.length = 0;
    fetchErrors.length = 0;
    clientAvailable = true;
  });

  test("channel is 'platform'", () => {
    expect(new PlatformPushAdapter().channel).toBe("platform");
  });

  test("POSTs to the correct dispatch endpoint with snake_case body", async () => {
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    const call = fetchCalls[0]!;
    expect(call.path).toBe("/v1/assistants/test-assistant-id/push/dispatch/");
    expect(call.method).toBe("POST");
    expect(call.body.delivery_id).toBe("signal-1");
    expect(call.body.source_event_name).toBe("schedule.notify");
    expect(call.body.title).toBe("Reminder");
    expect(call.body.body).toBe("Check the oven!");
    expect(call.body.deep_link_metadata).toEqual({
      type: "conversation",
      id: "conv-1",
    });
    expect(call.body.context_payload).toEqual({ jobId: "job-1" });
    expect(call.body.target_guardian_principal_id).toBeUndefined();
  });

  test("sets target_guardian_principal_id for guardian-sensitive events", async () => {
    const adapter = new PlatformPushAdapter();
    const payload = makePayload({ sourceEventName: "guardian.question" });
    const destination = makeDestination({
      metadata: { guardianPrincipalId: "principal-xyz" },
    });

    const result = await adapter.send(payload, destination);

    expect(result.success).toBe(true);
    expect(fetchCalls[0]?.body.target_guardian_principal_id).toBe(
      "principal-xyz",
    );
  });

  test("omits target_guardian_principal_id for non-guardian events even with principalId in metadata", async () => {
    const adapter = new PlatformPushAdapter();
    const payload = makePayload({ sourceEventName: "schedule.notify" });
    const destination = makeDestination({
      metadata: { guardianPrincipalId: "principal-xyz" },
    });

    const result = await adapter.send(payload, destination);

    expect(result.success).toBe(true);
    expect(fetchCalls[0]?.body.target_guardian_principal_id).toBeUndefined();
  });

  test("returns failure when platform client is unavailable", async () => {
    clientAvailable = false;
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(false);
    expect(result.error).toContain("platform client unavailable");
    expect(fetchCalls).toHaveLength(0);
  });

  test("retries on 5xx responses and succeeds on eventual 200", async () => {
    fetchResponses.push(
      { ok: false, status: 503, body: "service unavailable" },
      { ok: false, status: 500, body: "internal error" },
      { ok: true, status: 200, body: "{}" },
    );
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(fetchCalls).toHaveLength(3);
  });

  test("returns failure after exhausting all retries on persistent 5xx", async () => {
    fetchResponses.push(
      { ok: false, status: 500, body: "error" },
      { ok: false, status: 502, body: "bad gateway" },
      { ok: false, status: 503, body: "unavailable" },
      { ok: false, status: 500, body: "still failing" },
    );
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
    // 1 initial + 3 retries = 4 attempts
    expect(fetchCalls).toHaveLength(4);
  });

  test("bounds every attempt with an abort signal", async () => {
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(fetchCalls[0]?.hasAbortSignal).toBe(true);
  });

  test("retries attempts that abort on the per-attempt timeout", async () => {
    fetchErrors.push(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    fetchResponses.push({ ok: true, status: 200, body: '{"tokens_sent": 1}' });

    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(result.remotePushAccepted).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test("does not retry on 4xx responses", async () => {
    fetchResponses.push({ ok: false, status: 400, body: "bad request" });
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
    expect(fetchCalls).toHaveLength(1);
  });

  test("preserves an explicit empty platform list with legacy acceptance", async () => {
    fetchResponses.push({
      ok: true,
      status: 200,
      body: '{"tokens_sent":2,"accepted_platforms":[]}',
    });
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(result.remotePushAccepted).toBe(true);
    expect(result.remotePushPlatforms).toEqual([]);
  });

  test("preserves a successful provider from the final partial 503", async () => {
    fetchResponses.push(
      {
        ok: false,
        status: 503,
        body: '{"accepted_platforms":["ios"]}',
      },
      { ok: false, status: 503, body: "{}" },
      { ok: false, status: 503, body: "{}" },
      {
        ok: false,
        status: 503,
        body: '{"accepted_platforms":["android"]}',
      },
    );

    const result = await new PlatformPushAdapter().send(
      makePayload(),
      makeDestination(),
    );

    expect(result.success).toBe(false);
    expect(result.remotePushPlatforms).toEqual(["ios", "android"]);
  });

  test("reports remotePushAccepted: false on 202 skipped (flag off)", async () => {
    fetchResponses.push({
      ok: true,
      status: 202,
      body: '{"skipped": "flag_off"}',
    });
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(result.remotePushAccepted).toBe(false);
  });

  test("reports remotePushAccepted: false on 200 with tokens_sent 0", async () => {
    fetchResponses.push({
      ok: true,
      status: 200,
      body: '{"idempotent": true, "tokens_sent": 0}',
    });
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(result.remotePushAccepted).toBe(false);
  });

  test("reports remotePushAccepted: false when the success body is unparseable", async () => {
    fetchResponses.push({ ok: true, status: 200, body: "not json" });
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(true);
    expect(result.remotePushAccepted).toBe(false);
  });

  test("leaves remotePushAccepted unset on non-2xx failure", async () => {
    fetchResponses.push({ ok: false, status: 400, body: "bad request" });
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(false);
    expect(result.remotePushAccepted).toBeUndefined();
  });

  test("leaves remotePushAccepted unset when the platform client is unavailable", async () => {
    clientAvailable = false;
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(false);
    expect(result.remotePushAccepted).toBeUndefined();
  });

  // A lock screen renders no markdown, so any marker that survives to the
  // dispatch body reads as literal punctuation. See `stripMarkdownForPreview`.
  describe("markdown flattening", () => {
    test("flattens markdown out of the dispatched title and body", async () => {
      const adapter = new PlatformPushAdapter();
      const payload = makePayload({
        copy: {
          title: "**Build** finished",
          body: [
            "Here is the clip: ![vellum scene](vellum://workspace/a.mp4)",
            "```ts",
            "const a = 1;",
            "```",
            "| name | value |",
            "| --- | --- |",
            "| a | 1 |",
          ].join("\n"),
        },
      });

      const result = await adapter.send(payload, makeDestination());

      expect(result.success).toBe(true);
      const dispatched = fetchCalls[0]!.body;
      expect(dispatched.title).toBe("Build finished");
      const dispatchedBody = dispatched.body as string;
      expect(dispatchedBody).not.toContain("![");
      expect(dispatchedBody).not.toContain("```");
      expect(dispatchedBody).not.toContain("|");
      expect(dispatchedBody).toContain("Here is the clip:");
      expect(dispatchedBody).toContain("const a = 1;");
      expect(dispatchedBody).toContain("name value");
    });

    // Guardian question copy joins its question and instruction with a blank
    // line, and iOS renders the break, so flattening must not collapse it.
    test("preserves newlines in the dispatched body", async () => {
      const adapter = new PlatformPushAdapter();
      const payload = makePayload({
        copy: {
          title: "Question",
          body: "Should I book the flight?\n\nReply here to answer.",
        },
      });

      const result = await adapter.send(payload, makeDestination());

      expect(result.success).toBe(true);
      expect(fetchCalls[0]!.body.body).toBe(
        "Should I book the flight?\n\nReply here to answer.",
      );
    });

    test("leaves plain prose untouched", async () => {
      const adapter = new PlatformPushAdapter();
      const result = await adapter.send(makePayload(), makeDestination());

      expect(result.success).toBe(true);
      expect(fetchCalls[0]!.body.title).toBe("Reminder");
      expect(fetchCalls[0]!.body.body).toBe("Check the oven!");
    });

    // The pass-through path copies a verbatim `requestedMessage` into both the
    // title and the body, so media-only copy flattens both to nothing. Every
    // empty-copy guard in the pipeline runs upstream of this adapter, and the
    // platform's serializer rejects a blank title, so an unrecovered field
    // costs the whole notification.
    describe("copy that flattens to nothing", () => {
      test("names the media instead of dispatching blank fields", async () => {
        const adapter = new PlatformPushAdapter();
        const embed = "![clip](vellum://workspace/a.mp4)";
        const payload = makePayload({ copy: { title: embed, body: embed } });

        const result = await adapter.send(payload, makeDestination());

        expect(result.success).toBe(true);
        expect(fetchCalls[0]!.body.title).toBe("Sent clip");
        expect(fetchCalls[0]!.body.body).toBe("Sent clip");
      });

      test("counts several embeds", async () => {
        const adapter = new PlatformPushAdapter();
        const embeds =
          "![one](vellum://workspace/1.mp4) ![two](https://e.com/2.png)";
        const payload = makePayload({ copy: { title: embeds, body: embeds } });

        await adapter.send(payload, makeDestination());

        expect(fetchCalls[0]!.body.title).toBe("Sent 2 attachments");
      });

      // Nothing nameable is left, so the original beats a blank field: ugly
      // copy still delivers, an empty title is a 400.
      test("keeps the original when there is no media to name", async () => {
        const adapter = new PlatformPushAdapter();
        const payload = makePayload({ copy: { title: "###", body: "###" } });

        await adapter.send(payload, makeDestination());

        expect(fetchCalls[0]!.body.title).toBe("###");
      });
    });
  });

  test("omits optional fields when absent from payload", async () => {
    const adapter = new PlatformPushAdapter();
    const payload: ChannelDeliveryPayload = {
      sourceEventName: "schedule.notify",
      copy: { title: "Hi", body: "Hello" },
      urgency: "medium",
    };

    const result = await adapter.send(payload, makeDestination());

    expect(result.success).toBe(true);
    const body = fetchCalls[0]?.body ?? {};
    expect(body.delivery_id).toBeUndefined();
    expect(body.deep_link_metadata).toBeUndefined();
    expect(body.context_payload).toBeUndefined();
  });
});
