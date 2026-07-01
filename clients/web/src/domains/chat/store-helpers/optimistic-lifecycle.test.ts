import { describe, expect, it } from "bun:test";

import {
  optimisticCancel,
  optimisticRestore,
  optimisticRetire,
  type OptimisticLifecycleConfig,
} from "@/domains/chat/store-helpers/optimistic-lifecycle";

// ---------------------------------------------------------------------------
// Test fixture: a minimal entry/status shape exercising both store variants.
// `completedAt` lets us cover the `isSettled` guard (background-task style).
// ---------------------------------------------------------------------------

type Status = "running" | "cancelled" | "completed" | "failed";

interface Entry {
  id: string;
  status: Status;
  completedAt?: number;
  stopReason?: string;
}

const NOW = 1700000000000;

function config(
  overrides: Partial<OptimisticLifecycleConfig<Entry, Status>> = {},
): OptimisticLifecycleConfig<Entry, Status> {
  return {
    getStatus: (entry) => entry.status,
    isActive: (status) => status === "running",
    cancelledStatus: "cancelled",
    applyCancel: (entry) => ({ ...entry, status: "cancelled", completedAt: NOW }),
    applyRestore: (entry, prev) => ({
      ...entry,
      status: prev,
      completedAt: undefined,
    }),
    applyRetire: (entry) => ({
      ...entry,
      status: "cancelled",
      stopReason: "daemon_restarted",
      completedAt: NOW,
    }),
    ...overrides,
  };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return { id: "e-1", status: "running", ...overrides };
}

describe("optimisticCancel", () => {
  it("applies the optimistic transition to an active entry", () => {
    const next = optimisticCancel(entry(), config());
    expect(next).toEqual({ id: "e-1", status: "cancelled", completedAt: NOW });
  });

  it("is a no-op for an unknown entry", () => {
    expect(optimisticCancel(undefined, config())).toBeNull();
  });

  it("is a no-op for an already-terminal entry", () => {
    expect(optimisticCancel(entry({ status: "completed" }), config())).toBeNull();
    expect(optimisticCancel(entry({ status: "cancelled" }), config())).toBeNull();
  });
});

describe("optimisticRestore", () => {
  it("reverts an optimistically-cancelled entry to the prior status", () => {
    const cancelled = entry({ status: "cancelled", completedAt: NOW });
    const next = optimisticRestore(cancelled, "running", config());
    expect(next).toEqual({ id: "e-1", status: "running", completedAt: undefined });
  });

  it("is a no-op for an unknown entry", () => {
    expect(optimisticRestore(undefined, "running", config())).toBeNull();
  });

  it("is a no-op when the entry is not in the optimistic cancelled state", () => {
    expect(
      optimisticRestore(entry({ status: "running" }), "running", config()),
    ).toBeNull();
    expect(
      optimisticRestore(entry({ status: "failed" }), "running", config()),
    ).toBeNull();
  });

  it("respects isSettled — a real terminal that landed is not revived", () => {
    const settled = entry({ status: "cancelled", completedAt: NOW });
    const next = optimisticRestore(
      settled,
      "running",
      config({ isSettled: (e) => e.completedAt != null }),
    );
    expect(next).toBeNull();
  });

  it("restores when isSettled reports the entry is not yet settled", () => {
    const cancelled = entry({ status: "cancelled" });
    const next = optimisticRestore(
      cancelled,
      "running",
      config({ isSettled: (e) => e.completedAt != null }),
    );
    expect(next).toEqual({ id: "e-1", status: "running", completedAt: undefined });
  });
});

describe("optimisticRetire", () => {
  it("retires a still-active entry with the store's terminal fields", () => {
    const next = optimisticRetire(entry({ status: "running" }), config());
    expect(next).toEqual({
      id: "e-1",
      status: "cancelled",
      stopReason: "daemon_restarted",
      completedAt: NOW,
    });
  });

  it("leaves an already-terminal entry untouched", () => {
    expect(optimisticRetire(entry({ status: "completed" }), config())).toBeNull();
    expect(optimisticRetire(entry({ status: "cancelled" }), config())).toBeNull();
  });

  it("is a no-op for an unknown entry", () => {
    expect(optimisticRetire(undefined, config())).toBeNull();
  });
});
