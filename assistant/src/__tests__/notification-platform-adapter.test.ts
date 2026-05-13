import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock logger ──────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Mock sleep so retry tests don't slow down the suite ──────────────────────

mock.module("../util/retry.js", () => ({
  sleep: async (_ms: number): Promise<void> => {},
  isRetryableStatus: (status: number): boolean =>
    status === 429 || status >= 500,
  isRetryableNetworkError: (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    const codes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);
    const code = (error as { code?: string }).code;
    if (code && codes.has(code)) return true;
    if (error.cause instanceof Error) {
      const causeCode = (error.cause as { code?: string }).code;
      if (causeCode && codes.has(causeCode)) return true;
    }
    return false;
  },
}));

// ── VellumPlatformClient mock state ──────────────────────────────────────────

interface FetchCall {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

const fetchCalls: FetchCall[] = [];
const fetchResponses: Array<{ ok: boolean; status: number; body?: string }> = [];
let clientAvailable = true;

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => {
      if (!clientAvailable) return null;
      return {
        platformAssistantId: "test-assistant-id",
        fetch: async (path: string, init?: RequestInit) => {
          const body = init?.body
            ? (JSON.parse(init.body as string) as Record<string, unknown>)
            : {};
          fetchCalls.push({ path, method: init?.method ?? "GET", body });
          const response = fetchResponses.shift() ?? {
            ok: true,
            status: 200,
            body: "{}",
          };
          return {
            ok: response.ok,
            status: response.status,
            text: async () => response.body ?? "",
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
    sourceEventName: "schedule.notify",
    copy: { title: "Reminder", body: "Check the oven!" },
    deepLinkTarget: { type: "conversation", id: "conv-1" },
    contextPayload: { jobId: "job-1" },
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
    expect(call.path).toBe(
      "/v1/assistants/test-assistant-id/push/dispatch/",
    );
    expect(call.method).toBe("POST");
    expect(call.body.delivery_id).toBe("delivery-uuid-1");
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

  test("does not retry on 4xx responses", async () => {
    fetchResponses.push({ ok: false, status: 400, body: "bad request" });
    const adapter = new PlatformPushAdapter();
    const result = await adapter.send(makePayload(), makeDestination());

    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
    expect(fetchCalls).toHaveLength(1);
  });

  test("omits optional fields when absent from payload", async () => {
    const adapter = new PlatformPushAdapter();
    const payload: ChannelDeliveryPayload = {
      sourceEventName: "schedule.notify",
      copy: { title: "Hi", body: "Hello" },
    };

    const result = await adapter.send(payload, makeDestination());

    expect(result.success).toBe(true);
    const body = fetchCalls[0]?.body ?? {};
    expect(body.delivery_id).toBeUndefined();
    expect(body.deep_link_metadata).toBeUndefined();
    expect(body.context_payload).toBeUndefined();
  });
});
