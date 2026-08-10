import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import type { DiskPressureStatus } from "@vellumai/assistant-api";

let nativeAndroid = false;

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
}));

const { DiskPressureBannerSlot } = await import(
  "@/domains/chat/components/disk-pressure-banner-slot"
);

const warningStatus: DiskPressureStatus = {
  enabled: true,
  state: "warning",
  locked: false,
  acknowledged: false,
  overrideActive: false,
  effectivelyLocked: false,
  lockId: null,
  usagePercent: 85,
  thresholdPercent: 90,
  path: "/workspace",
  lastCheckedAt: null,
  blockedCapabilities: [],
  error: null,
};

const diskPressure: UseDiskPressureMonitorResult = {
  status: warningStatus,
  mode: "warning",
  hasResolvedStatus: true,
  isAcknowledging: false,
  acknowledgeError: null,
  acknowledge: async () => {},
  applyStatusEvent: () => {},
  refresh: async () => {},
};

function renderSlot() {
  return render(
    <MemoryRouter>
      <DiskPressureBannerSlot
        diskPressure={diskPressure}
        assistantId="assistant-1"
        assistantStateKind="active"
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  nativeAndroid = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("DiskPressureBannerSlot", () => {
  test("native Android keeps storage management but hides the upgrade action", () => {
    nativeAndroid = true;
    renderSlot();

    expect(screen.getByRole("button", { name: "Manage Storage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  });

  test("web keeps the storage upgrade action", () => {
    renderSlot();

    expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
  });
});
