import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockResponse {
  data: unknown;
  error?: unknown;
  response: { ok: boolean; status: number; statusText: string };
}

let mockGet: ReturnType<typeof mock<(...args: unknown[]) => Promise<MockResponse>>>;
let mockPut: ReturnType<typeof mock<(...args: unknown[]) => Promise<MockResponse>>>;

mock.module("@/generated/api/client.gen", () => ({
  client: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

const {
  fetchChannelPolicies,
  setChannelPolicy,
  fetchConversationOverride,
  setConversationOverride,
  isInternalChannel,
  ApiError,
} = await import("./api");

function ok<T>(body: T): MockResponse {
  return {
    data: body,
    response: { ok: true, status: 200, statusText: "OK" },
  };
}

function err(status: number, error: unknown): MockResponse {
  return {
    data: null,
    error,
    response: { ok: false, status, statusText: "Error" },
  };
}

beforeEach(() => {
  mockGet = mock(async () => ok({}));
  mockPut = mock(async () => ok({}));
});

afterEach(() => {
  mockGet.mockClear();
  mockPut.mockClear();
});

describe("isInternalChannel", () => {
  test("flags vellum/platform/a2a as internal", () => {
    expect(isInternalChannel("vellum")).toBe(true);
    expect(isInternalChannel("platform")).toBe(true);
    expect(isInternalChannel("a2a")).toBe(true);
  });

  test("client-controllable channels are not internal", () => {
    expect(isInternalChannel("slack")).toBe(false);
    expect(isInternalChannel("telegram")).toBe(false);
    expect(isInternalChannel("email")).toBe(false);
  });
});

describe("fetchChannelPolicies", () => {
  test("filters internal channels out of the gateway response", async () => {
    // §8.1: even if the gateway forgets to omit internal channels, the
    // client double-filters so the UI never offers a way to lock them.
    mockGet = mock(async () =>
      ok({
        policies: [
          {
            channelType: "slack",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "vellum",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "platform",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "a2a",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "email",
            policy: "guardian_only",
            note: null,
            updatedAt: null,
          },
        ],
      }),
    );

    const policies = await fetchChannelPolicies("asst-1");

    expect(policies.map((p) => p.channelType).sort()).toEqual([
      "email",
      "slack",
    ]);
  });

  test("normalises an unrecognised policy value back to the default", async () => {
    // Belt-and-suspenders: if the gateway ever surfaces a non-canonical
    // value (legacy row, partial migration), we don't crash the dropdown.
    mockGet = mock(async () =>
      ok({
        policies: [
          {
            channelType: "slack",
            policy: "made-up-value",
            note: null,
            updatedAt: null,
          },
        ],
      }),
    );

    const policies = await fetchChannelPolicies("asst-1");
    expect(policies[0].policy).toBe("trusted_contacts");
  });

  test("throws ApiError with the server message on failure", async () => {
    mockGet = mock(async () => err(500, { error: "boom" }));
    await expect(fetchChannelPolicies("asst-1")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("setChannelPolicy", () => {
  test("refuses to write to an internal channel without contacting the gateway", async () => {
    await expect(
      setChannelPolicy("asst-1", "vellum", "no_one"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockPut).not.toHaveBeenCalled();
  });

  test("sends the policy payload to the assistant-scoped PUT route", async () => {
    mockPut = mock(async () =>
      ok({
        policy: {
          channelType: "slack",
          policy: "guardian_only",
          note: null,
          updatedAt: 1,
        },
      }),
    );

    const result = await setChannelPolicy("asst-1", "slack", "guardian_only");

    expect(mockPut).toHaveBeenCalledTimes(1);
    const call = mockPut.mock.calls[0] as unknown as [
      {
        url: string;
        path: { assistant_id: string; channel_type: string };
        body: { policy: string; note: string | null };
      },
    ];
    expect(call[0].url).toContain(
      "/v1/assistants/{assistant_id}/channel-admission-policy/{channel_type}",
    );
    expect(call[0].path).toEqual({
      assistant_id: "asst-1",
      channel_type: "slack",
    });
    expect(call[0].body).toEqual({ policy: "guardian_only", note: null });
    expect(result.policy).toBe("guardian_only");
  });
});

describe("conversation override", () => {
  test("fetchConversationOverride returns the gateway view shape", async () => {
    mockGet = mock(async () =>
      ok({
        override: {
          conversationId: "slack:C0123",
          channelType: "slack",
          override: null,
          typeFloor: "trusted_contacts",
          updatedAt: null,
        },
      }),
    );

    const view = await fetchConversationOverride("asst-1", "slack:C0123");

    expect(view.conversationId).toBe("slack:C0123");
    expect(view.override).toBeNull();
    expect(view.typeFloor).toBe("trusted_contacts");
  });

  test("setConversationOverride accepts null to clear", async () => {
    mockPut = mock(async () =>
      ok({
        override: {
          conversationId: "slack:C0123",
          channelType: "slack",
          override: null,
          typeFloor: "trusted_contacts",
          updatedAt: 1,
        },
      }),
    );

    await setConversationOverride("asst-1", "slack:C0123", null, "slack");

    const call = mockPut.mock.calls[0] as unknown as [
      { body: { floor: unknown; channelType: unknown } },
    ];
    // channelType is required — must be a known channel ID.
    expect(call[0].body).toEqual({ floor: null, channelType: "slack" });
  });
});
