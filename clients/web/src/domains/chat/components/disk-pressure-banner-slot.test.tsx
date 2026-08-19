import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import type { DiskPressureStatus } from "@vellumai/assistant-api";

let nativeAndroid = false;

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
}));

const { DiskPressureBannerSlot, useDiskPressureBannerVisible } = await import(
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

const acknowledgementRequired: UseDiskPressureMonitorResult = {
  ...diskPressure,
  status: {
    ...warningStatus,
    state: "critical",
    locked: true,
    effectivelyLocked: true,
    usagePercent: 97,
  },
  mode: "acknowledgement-required",
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

// Mirrors the chat route's precedence wiring: the resource-pressure slot only
// gets the space when the disk banner is not actually visible.
function PrecedenceHarness({
  monitor,
}: {
  monitor: UseDiskPressureMonitorResult;
}) {
  const diskVisible = useDiskPressureBannerVisible(monitor, "assistant-1");
  return (
    <MemoryRouter>
      <DiskPressureBannerSlot
        diskPressure={monitor}
        assistantId="assistant-1"
        assistantStateKind="active"
      />
      {diskVisible ? null : <div data-testid="resource-banner-stand-in" />}
    </MemoryRouter>
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

  test("dismissing the warning yields the slot to the resource banner", () => {
    render(<PrecedenceHarness monitor={diskPressure} />);

    expect(screen.getByTestId("disk-pressure-banner")).toBeTruthy();
    expect(screen.queryByTestId("resource-banner-stand-in")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByTestId("disk-pressure-banner")).toBeNull();
    expect(screen.getByTestId("resource-banner-stand-in")).toBeTruthy();
  });

  test("a stored permanent suppress frees the slot from the first render", () => {
    localStorage.setItem("vellum:diskPressureSuppressed:assistant-1", "true");

    render(<PrecedenceHarness monitor={diskPressure} />);

    expect(screen.queryByTestId("disk-pressure-banner")).toBeNull();
    expect(screen.getByTestId("resource-banner-stand-in")).toBeTruthy();
  });

  test("acknowledgement-required ignores dismiss flags and keeps precedence", () => {
    localStorage.setItem("vellum:diskPressureDismissed:assistant-1", "true");
    localStorage.setItem("vellum:diskPressureSuppressed:assistant-1", "true");

    render(<PrecedenceHarness monitor={acknowledgementRequired} />);

    expect(screen.getByTestId("disk-pressure-banner")).toBeTruthy();
    expect(screen.queryByTestId("resource-banner-stand-in")).toBeNull();
  });
});
