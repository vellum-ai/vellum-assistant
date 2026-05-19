import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createElement } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type {
  AcknowledgeAssistantDiskPressureResult,
  GetAssistantDiskPressureStatusResult,
} from "@/lib/assistants/api.js";
import { createDiskPressureStatus as diskPressureStatus } from "@/lib/assistants/disk-pressure-test-fixtures.js";

const getAssistantDiskPressureStatusMock = mock(
  async (_assistantId: string): Promise<GetAssistantDiskPressureStatusResult> => ({
    ok: true as const,
    status: 200,
    data: { status: diskPressureStatus() },
  }),
);

const acknowledgeAssistantDiskPressureMock = mock(
  async (
    _assistantId: string,
  ): Promise<AcknowledgeAssistantDiskPressureResult> => ({
    ok: true as const,
    status: 200,
    data: { status: diskPressureStatus({ acknowledged: true }) },
  }),
);

mock.module("@/lib/assistants/api.js", () => ({
  getAssistantDiskPressureStatus: getAssistantDiskPressureStatusMock,
  acknowledgeAssistantDiskPressure: acknowledgeAssistantDiskPressureMock,
}));

import {
  areDiskPressureStatusesEqual,
  formatDiskPressureUsage,
  getDiskPressureChatBlockMessage,
  getDiskPressureChatBlockReason,
  getDiskPressureMonitorMode,
  isChatInputDisabledByDiskPressure,
  isDiskPressureCleanupActive,
  requiresDiskPressureAcknowledgement,
  shouldShowDiskPressureBanner,
  shouldEnableDiskPressureMonitor,
} from "@/lib/assistants/disk-pressure.js";
import {
  type UseDiskPressureMonitorResult,
  useDiskPressureMonitor,
} from "@/lib/assistants/useDiskPressureMonitor.js";

type DiskPressureSuccessResult = {
  ok: true;
  status: number;
  data: { status: ReturnType<typeof diskPressureStatus> };
};

function MonitorProbe({
  assistantId,
  enabled,
  onRender,
}: {
  assistantId: string | null;
  enabled: boolean;
  onRender: (result: UseDiskPressureMonitorResult) => void;
}) {
  const result = useDiskPressureMonitor({
    assistantId,
    enabled,
    cadenceMs: 600_000,
  });
  onRender(result);
  return null;
}

function expectMonitorResult(
  result: UseDiskPressureMonitorResult | null,
): UseDiskPressureMonitorResult {
  expect(result).not.toBeNull();
  return result as UseDiskPressureMonitorResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function deferredDiskPressureResult() {
  return deferred<DiskPressureSuccessResult>();
}

beforeEach(() => {
  getAssistantDiskPressureStatusMock.mockClear();
  acknowledgeAssistantDiskPressureMock.mockClear();
  getAssistantDiskPressureStatusMock.mockImplementation(
    async (_assistantId: string) => ({
      ok: true as const,
      status: 200,
      data: { status: diskPressureStatus() },
    }),
  );
  acknowledgeAssistantDiskPressureMock.mockImplementation(
    async (_assistantId: string) => ({
      ok: true as const,
      status: 200,
      data: { status: diskPressureStatus({ acknowledged: true }) },
    }),
  );
});

afterEach(() => {
  cleanup();
});

describe("disk pressure runtime helpers", () => {
  test("cleanup is active only after an enabled runtime lock is acknowledged", () => {
    expect(
      isDiskPressureCleanupActive(
        diskPressureStatus({
          acknowledged: true,
          effectivelyLocked: true,
        }),
      ),
    ).toBe(true);
    expect(
      isDiskPressureCleanupActive(
        diskPressureStatus({ enabled: false, effectivelyLocked: true }),
      ),
    ).toBe(false);
    expect(
      isDiskPressureCleanupActive(
        diskPressureStatus({ effectivelyLocked: true }),
      ),
    ).toBe(false);
  });

  test("acknowledgement is required only for unacknowledged active locks without an override", () => {
    expect(
      requiresDiskPressureAcknowledgement(
        diskPressureStatus({ locked: true, effectivelyLocked: true }),
      ),
    ).toBe(true);
    expect(
      requiresDiskPressureAcknowledgement(
        diskPressureStatus({
          locked: true,
          acknowledged: true,
          effectivelyLocked: true,
        }),
      ),
    ).toBe(false);
    expect(
      requiresDiskPressureAcknowledgement(
        diskPressureStatus({
          locked: true,
          effectivelyLocked: true,
          overrideActive: true,
        }),
      ),
    ).toBe(false);
  });

  test("banner visibility tracks only acknowledgement-required and cleanup modes", () => {
    expect(
      shouldShowDiskPressureBanner(diskPressureStatus({ state: "ok" })),
    ).toBe(false);
    expect(
      shouldShowDiskPressureBanner(
        diskPressureStatus({ state: "critical" }),
      ),
    ).toBe(false);
    expect(
      shouldShowDiskPressureBanner(diskPressureStatus({ locked: true })),
    ).toBe(false);
    expect(
      shouldShowDiskPressureBanner(
        diskPressureStatus({ overrideActive: true }),
      ),
    ).toBe(false);
    expect(
      shouldShowDiskPressureBanner(
        diskPressureStatus({ effectivelyLocked: true }),
      ),
    ).toBe(true);
    expect(
      shouldShowDiskPressureBanner(
        diskPressureStatus({
          acknowledged: true,
          effectivelyLocked: true,
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowDiskPressureBanner(
        diskPressureStatus({ enabled: false, state: "critical" }),
      ),
    ).toBe(false);
  });

  test("monitor mode separates inactive, acknowledgement-required, and cleanup states", () => {
    expect(getDiskPressureMonitorMode(diskPressureStatus())).toBe("inactive");
    expect(
      getDiskPressureMonitorMode(diskPressureStatus({ state: "critical" })),
    ).toBe("inactive");
    expect(
      getDiskPressureMonitorMode(
        diskPressureStatus({ locked: true, effectivelyLocked: true }),
      ),
    ).toBe("acknowledgement-required");
    expect(
      getDiskPressureMonitorMode(
        diskPressureStatus({
          locked: true,
          acknowledged: true,
          effectivelyLocked: true,
        }),
      ),
    ).toBe("cleanup");
  });

  test("safe storage chat gating blocks only acknowledgement-required status when monitored", () => {
    expect(
      shouldEnableDiskPressureMonitor({
        safeStorageLimits: true,
        assistantStateKind: "active",
        assistantId: "assistant-a",
      }),
    ).toBe(true);
    expect(
      shouldEnableDiskPressureMonitor({
        safeStorageLimits: false,
        assistantStateKind: "active",
        assistantId: "assistant-a",
      }),
    ).toBe(false);
    // Unresolved status no longer blocks input — we don't gate on pending.
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: false,
        status: null,
      }),
    ).toBe(false);
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({
          state: "ok",
          locked: false,
          effectivelyLocked: false,
        }),
      }),
    ).toBe(false);
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({
          acknowledged: true,
          effectivelyLocked: true,
        }),
      }),
    ).toBe(false);
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({ effectivelyLocked: true }),
      }),
    ).toBe(true);
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: false,
        hasResolvedStatus: false,
        status: null,
      }),
    ).toBe(false);
  });

  test("chat block reason does not block while status is pending", () => {
    expect(
      getDiskPressureChatBlockReason({
        monitorEnabled: true,
        hasResolvedStatus: false,
        status: null,
      }),
    ).toBeNull();
    expect(
      getDiskPressureChatBlockReason({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({ effectivelyLocked: true }),
      }),
    ).toBe("acknowledgement-required");
    expect(
      getDiskPressureChatBlockReason({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({
          acknowledged: true,
          effectivelyLocked: true,
        }),
      }),
    ).toBeNull();
  });

  test("chat block messages are user-facing", () => {
    expect(
      getDiskPressureChatBlockMessage("acknowledgement-required"),
    ).toContain("must be acknowledged");
  });

  test("usage formatter rounds known percentages and handles missing metrics", () => {
    expect(
      formatDiskPressureUsage(diskPressureStatus({ usagePercent: 89.6 })),
    ).toBe("90%");
    expect(
      formatDiskPressureUsage(diskPressureStatus({ usagePercent: null })),
    ).toBe("Unknown");
    expect(
      formatDiskPressureUsage(
        diskPressureStatus({ usagePercent: Number.NaN }),
      ),
    ).toBe("Unknown");
  });

  test("status equality covers scalar fields and blocked capabilities", () => {
    const status = diskPressureStatus({
      blockedCapabilities: ["agent-turns"],
    });

    expect(areDiskPressureStatusesEqual(status, { ...status })).toBe(true);
    expect(
      areDiskPressureStatusesEqual(status, {
        ...status,
        blockedCapabilities: ["background-work"],
      }),
    ).toBe(false);
    expect(
      areDiskPressureStatusesEqual(status, {
        ...status,
        acknowledged: true,
      }),
    ).toBe(false);
  });
});

describe("useDiskPressureMonitor", () => {
  test("polls assistant disk pressure status when enabled", async () => {
    getAssistantDiskPressureStatusMock.mockImplementation(
      async (_assistantId: string) => ({
        ok: true as const,
        status: 200,
        data: {
          status: diskPressureStatus({
            state: "critical",
            usagePercent: 93,
          }),
        },
      }),
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status?.state).toBe("critical");
    });

    expect(getAssistantDiskPressureStatusMock).toHaveBeenCalledWith(
      "assistant-a",
    );
    const current = expectMonitorResult(latest);
    expect(current.mode).toBe("inactive");
    expect(current.hasResolvedStatus).toBe(true);
  });

  test("acknowledges cleanup mode through the assistant API", async () => {
    getAssistantDiskPressureStatusMock.mockImplementation(
      async (_assistantId: string) => ({
        ok: true as const,
        status: 200,
        data: {
          status: diskPressureStatus({
            locked: true,
            effectivelyLocked: true,
          }),
        },
      }),
    );
    acknowledgeAssistantDiskPressureMock.mockImplementation(
      async (_assistantId: string) => ({
        ok: true as const,
        status: 200,
        data: {
          status: diskPressureStatus({
            locked: true,
            acknowledged: true,
            effectivelyLocked: true,
          }),
        },
      }),
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status?.effectivelyLocked).toBe(true);
    });

    await act(async () => {
      await expectMonitorResult(latest).acknowledge();
    });

    expect(acknowledgeAssistantDiskPressureMock).toHaveBeenCalledWith(
      "assistant-a",
    );
    const current = expectMonitorResult(latest);
    expect(current.status?.acknowledged).toBe(true);
    expect(current.acknowledgeError).toBeNull();
  });

  test("clears local status when disabled", async () => {
    getAssistantDiskPressureStatusMock.mockImplementation(
      async (_assistantId: string) => ({
        ok: true as const,
        status: 200,
        data: {
          status: diskPressureStatus({
            state: "critical",
            usagePercent: 95,
          }),
        },
      }),
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    const { rerender } = render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status?.state).toBe("critical");
    });

    rerender(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: false,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status).toBeNull();
    });
    const current = expectMonitorResult(latest);
    expect(current.mode).toBe("inactive");
    expect(current.hasResolvedStatus).toBe(false);
  });

  test("clears local status when assistant id is missing", async () => {
    getAssistantDiskPressureStatusMock.mockImplementation(
      async (_assistantId: string) => ({
        ok: true as const,
        status: 200,
        data: {
          status: diskPressureStatus({
            state: "critical",
            usagePercent: 95,
          }),
        },
      }),
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    const { rerender } = render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status?.state).toBe("critical");
    });

    rerender(
      createElement(MonitorProbe, {
        assistantId: null,
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status).toBeNull();
    });
    const current = expectMonitorResult(latest);
    expect(current.mode).toBe("inactive");
    expect(current.hasResolvedStatus).toBe(false);
  });

  test("applies live status event payloads immediately", async () => {
    let latest: UseDiskPressureMonitorResult | null = null;
    render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status?.state).toBe("ok");
    });

    act(() => {
      expectMonitorResult(latest).applyStatusEvent(
        diskPressureStatus({
          state: "critical",
          usagePercent: 88,
        }),
      );
    });

    const current = expectMonitorResult(latest);
    expect(current.status?.state).toBe("critical");
    expect(current.hasResolvedStatus).toBe(true);
  });

  test("treats null live status events as resolved clears", async () => {
    let latest: UseDiskPressureMonitorResult | null = null;
    render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status?.state).toBe("ok");
    });

    act(() => {
      expectMonitorResult(latest).applyStatusEvent(null);
    });

    const current = expectMonitorResult(latest);
    expect(current.status).toBeNull();
    expect(current.mode).toBe("inactive");
    expect(current.hasResolvedStatus).toBe(true);
  });

  test("leaves status unresolved when the status endpoint errors", async () => {
    getAssistantDiskPressureStatusMock.mockImplementation(
      async (_assistantId: string) => ({
        ok: false as const,
        status: 503,
        error: { detail: "unavailable" },
      }),
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(getAssistantDiskPressureStatusMock).toHaveBeenCalledWith(
        "assistant-a",
      );
    });

    const current = expectMonitorResult(latest);
    expect(current.status).toBeNull();
    expect(current.hasResolvedStatus).toBe(false);
  });

  test("ignores stale poll responses after a live status event", async () => {
    const pendingPoll = deferredDiskPressureResult();
    getAssistantDiskPressureStatusMock.mockImplementationOnce(
      async (_assistantId: string) => pendingPoll.promise,
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(getAssistantDiskPressureStatusMock).toHaveBeenCalledWith(
        "assistant-a",
      );
    });

    act(() => {
      expectMonitorResult(latest).applyStatusEvent(
        diskPressureStatus({
          state: "ok",
          locked: false,
          effectivelyLocked: false,
          usagePercent: 41,
        }),
      );
    });

    await act(async () => {
      pendingPoll.resolve({
        ok: true,
        status: 200,
        data: {
          status: diskPressureStatus({
            state: "critical",
            effectivelyLocked: true,
            usagePercent: 96,
          }),
        },
      });
      await pendingPoll.promise;
    });

    const current = expectMonitorResult(latest);
    expect(current.status?.state).toBe("ok");
    expect(current.status?.usagePercent).toBe(41);
    expect(current.hasResolvedStatus).toBe(true);
  });

  test("ignores stale poll responses after disabling the monitor", async () => {
    const pendingPoll = deferredDiskPressureResult();
    getAssistantDiskPressureStatusMock.mockImplementationOnce(
      async (_assistantId: string) => pendingPoll.promise,
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    const { rerender } = render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(getAssistantDiskPressureStatusMock).toHaveBeenCalledWith(
        "assistant-a",
      );
    });

    rerender(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: false,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await act(async () => {
      pendingPoll.resolve({
        ok: true,
        status: 200,
        data: {
          status: diskPressureStatus({
            state: "critical",
            effectivelyLocked: true,
          }),
        },
      });
      await pendingPoll.promise;
    });

    const current = expectMonitorResult(latest);
    expect(current.status).toBeNull();
    expect(current.hasResolvedStatus).toBe(false);
  });

  test("ignores stale poll responses after assistant id changes", async () => {
    const pendingPoll = deferredDiskPressureResult();
    getAssistantDiskPressureStatusMock.mockImplementationOnce(
      async (_assistantId: string) => pendingPoll.promise,
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    const { rerender } = render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(getAssistantDiskPressureStatusMock).toHaveBeenCalledWith(
        "assistant-a",
      );
    });

    rerender(
      createElement(MonitorProbe, {
        assistantId: "assistant-b",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(getAssistantDiskPressureStatusMock).toHaveBeenCalledWith(
        "assistant-b",
      );
      expect(latest?.status?.usagePercent).toBe(42);
    });

    await act(async () => {
      pendingPoll.resolve({
        ok: true,
        status: 200,
        data: {
          status: diskPressureStatus({
            state: "critical",
            effectivelyLocked: true,
            usagePercent: 97,
          }),
        },
      });
      await pendingPoll.promise;
    });

    const current = expectMonitorResult(latest);
    expect(current.status?.usagePercent).toBe(42);
    expect(current.hasResolvedStatus).toBe(true);
  });

  test("resets acknowledgement state when assistant id changes", async () => {
    getAssistantDiskPressureStatusMock.mockImplementation(
      async (_assistantId: string) => ({
        ok: true as const,
        status: 200,
        data: {
          status: diskPressureStatus({
            effectivelyLocked: true,
          }),
        },
      }),
    );
    const pendingAcknowledge = deferredDiskPressureResult();
    acknowledgeAssistantDiskPressureMock.mockImplementationOnce(
      async (_assistantId: string) => pendingAcknowledge.promise,
    );

    let latest: UseDiskPressureMonitorResult | null = null;
    const { rerender } = render(
      createElement(MonitorProbe, {
        assistantId: "assistant-a",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.status?.effectivelyLocked).toBe(true);
    });

    let acknowledgePromise!: Promise<void>;
    act(() => {
      acknowledgePromise = expectMonitorResult(latest).acknowledge();
    });

    await waitFor(() => {
      expect(latest?.isAcknowledging).toBe(true);
    });

    rerender(
      createElement(MonitorProbe, {
        assistantId: "assistant-b",
        enabled: true,
        onRender: (result) => {
          latest = result;
        },
      }),
    );

    await waitFor(() => {
      expect(latest?.isAcknowledging).toBe(false);
      expect(latest?.acknowledgeError).toBeNull();
      expect(latest?.status?.usagePercent).toBe(42);
    });

    await act(async () => {
      pendingAcknowledge.resolve({
        ok: true,
        status: 200,
        data: {
          status: diskPressureStatus({
            acknowledged: true,
            effectivelyLocked: true,
            usagePercent: 99,
          }),
        },
      });
      await acknowledgePromise;
    });

    const current = expectMonitorResult(latest);
    expect(current.status?.usagePercent).toBe(42);
  });
});
