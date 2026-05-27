import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BackgroundWakeIntent } from "./next-wake.js";

let mockPlatformAssistantId: string;
let mockClientFetch: ReturnType<typeof mock>;
let mockCreateClient: ReturnType<typeof mock>;

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: () => mockCreateClient(),
  },
}));

const {
  clearBackgroundWakeIntent,
  completeBackgroundWakeLease,
  publishBackgroundWakeIntent,
  renewBackgroundWakeLease,
} = await import("./platform-client.js");

const NOW = 1_800_000_000_000;

describe("background wake platform client", () => {
  beforeEach(() => {
    mockPlatformAssistantId = "asst-123";
    mockClientFetch = mock(async () => new Response('{"status":"stored"}'));
    mockCreateClient = mock(async () => ({
      platformAssistantId: mockPlatformAssistantId,
      fetch: mockClientFetch,
    }));
  });

  test("publishes derived wake intent fields to Django", async () => {
    const result = await publishBackgroundWakeIntent(intentFixture());

    expect(result).toEqual({ status: "published", httpStatus: 200 });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/assistants/asst-123/background-wake-intent/");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      reason: "schedule",
      source_generation: "bw1:opaque-hash",
      computed_at: new Date(NOW - 1_000).toISOString(),
      next_wake_at: new Date(NOW + 60_000).toISOString(),
      actual_next_due_at: new Date(NOW + 60_000).toISOString(),
      source_payload: {
        heartbeat: null,
        schedules: [
          {
            id: "schedule-1",
            nextRunAt: NOW + 60_000,
            mode: "wake",
            createdBy: "defer",
            status: "active",
            updatedAt: NOW - 5_000,
          },
        ],
      },
    });
  });

  test("preserves stable string sourceGeneration across recomputes", async () => {
    await publishBackgroundWakeIntent(
      intentFixture({
        computedAt: NOW - 1_000,
        sourceGeneration: "bw1:stable-source-hash",
      }),
    );
    await publishBackgroundWakeIntent(
      intentFixture({
        computedAt: NOW,
        sourceGeneration: "bw1:stable-source-hash",
      }),
    );

    const [, firstInit] = mockClientFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const [, secondInit] = mockClientFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(firstInit.body))).toMatchObject({
      source_generation: "bw1:stable-source-hash",
      computed_at: new Date(NOW - 1_000).toISOString(),
    });
    expect(JSON.parse(String(secondInit.body))).toMatchObject({
      source_generation: "bw1:stable-source-hash",
      computed_at: new Date(NOW).toISOString(),
    });
  });

  test("preserves numeric-looking sourceGeneration as a string", async () => {
    await publishBackgroundWakeIntent(
      intentFixture({ sourceGeneration: "42" }),
    );

    const [, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).source_generation).toBe("42");
  });

  test("clears wake intent with the last computed snapshot when available", async () => {
    mockClientFetch = mock(async () => new Response('{"status":"cleared"}'));
    mockCreateClient = mock(async () => ({
      platformAssistantId: mockPlatformAssistantId,
      fetch: mockClientFetch,
    }));

    const result = await clearBackgroundWakeIntent(
      intentFixture({ sourceGeneration: "bw1:opaque-hash" }),
    );

    expect(result).toEqual({ status: "cleared", httpStatus: 200 });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/assistants/asst-123/background-wake-intent/");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({
      source_generation: "bw1:opaque-hash",
      computed_at: new Date(NOW - 1_000).toISOString(),
    });
  });

  test("clears wake intent without generation data when no snapshot is available", async () => {
    await clearBackgroundWakeIntent(null);

    const [, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  test("renews background wake lease through Django", async () => {
    const result = await renewBackgroundWakeLease("lease/with/slash");

    expect(result).toEqual({ status: "renewed", httpStatus: 200 });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/v1/assistants/asst-123/background-wake-leases/lease%2Fwith%2Fslash/renew/",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  test("completes background wake lease with the next intent", async () => {
    const result = await completeBackgroundWakeLease({
      leaseId: "lease-123",
      status: "completed",
      nextIntent: intentFixture({ sourceGeneration: "bw1:next-hash" }),
    });

    expect(result).toEqual({ status: "completed", httpStatus: 200 });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/v1/assistants/asst-123/background-wake-leases/lease-123/complete/",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      status: "completed",
      next_intent: {
        reason: "schedule",
        source_generation: "bw1:next-hash",
        computed_at: new Date(NOW - 1_000).toISOString(),
        next_wake_at: new Date(NOW + 60_000).toISOString(),
        actual_next_due_at: new Date(NOW + 60_000).toISOString(),
        source_payload: {
          heartbeat: null,
          schedules: [
            {
              id: "schedule-1",
              nextRunAt: NOW + 60_000,
              mode: "wake",
              createdBy: "defer",
              status: "active",
              updatedAt: NOW - 5_000,
            },
          ],
        },
      },
    });
  });

  test("completes failed background wake lease with an error", async () => {
    await completeBackgroundWakeLease({
      leaseId: "lease-123",
      status: "failed",
      error: "scheduler exploded",
    });

    const [, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      status: "failed",
      error: "scheduler exploded",
    });
  });

  test("completes background wake lease with an explicit null next intent", async () => {
    await completeBackgroundWakeLease({
      leaseId: "lease-123",
      status: "completed",
      nextIntent: null,
    });

    const [, init] = mockClientFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      status: "completed",
      next_intent: null,
    });
  });

  test("skips when platform prerequisites are missing", async () => {
    mockCreateClient = mock(async () => null);

    await expect(publishBackgroundWakeIntent(intentFixture())).resolves.toEqual(
      {
        status: "skipped",
        reason: "missing_platform_client",
      },
    );
    expect(mockClientFetch).not.toHaveBeenCalled();

    mockCreateClient = mock(async () => ({
      platformAssistantId: "",
      fetch: mockClientFetch,
    }));

    await expect(publishBackgroundWakeIntent(intentFixture())).resolves.toEqual(
      {
        status: "skipped",
        reason: "missing_platform_assistant_id",
      },
    );
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  test("treats Django disabled no-op responses as success", async () => {
    mockClientFetch = mock(async () => new Response('{"status":"disabled"}'));
    mockCreateClient = mock(async () => ({
      platformAssistantId: mockPlatformAssistantId,
      fetch: mockClientFetch,
    }));

    await expect(publishBackgroundWakeIntent(intentFixture())).resolves.toEqual(
      {
        status: "published",
        httpStatus: 200,
      },
    );
  });

  test("throws on non-OK platform responses", async () => {
    mockClientFetch = mock(
      async () => new Response("bad gateway", { status: 502 }),
    );
    mockCreateClient = mock(async () => ({
      platformAssistantId: mockPlatformAssistantId,
      fetch: mockClientFetch,
    }));

    await expect(publishBackgroundWakeIntent(intentFixture())).rejects.toThrow(
      "Failed to publish background wake intent: HTTP 502: bad gateway",
    );
    await expect(clearBackgroundWakeIntent(intentFixture())).rejects.toThrow(
      "Failed to clear background wake intent: HTTP 502: bad gateway",
    );
    await expect(renewBackgroundWakeLease("lease-123")).rejects.toThrow(
      "Failed to renew background wake lease: HTTP 502: bad gateway",
    );
    await expect(
      completeBackgroundWakeLease({ leaseId: "lease-123", status: "failed" }),
    ).rejects.toThrow(
      "Failed to complete background wake lease: HTTP 502: bad gateway",
    );
  });
});

function intentFixture(
  overrides: Partial<BackgroundWakeIntent> = {},
): BackgroundWakeIntent {
  return {
    nextWakeAt: NOW + 60_000,
    actualNextDueAt: NOW + 60_000,
    reason: "schedule",
    sourceGeneration: "bw1:opaque-hash",
    computedAt: NOW - 1_000,
    sourcePayload: {
      heartbeat: null,
      schedules: [
        {
          id: "schedule-1",
          nextRunAt: NOW + 60_000,
          mode: "wake",
          createdBy: "defer",
          status: "active",
          updatedAt: NOW - 5_000,
        },
      ],
    },
    ...overrides,
  };
}
