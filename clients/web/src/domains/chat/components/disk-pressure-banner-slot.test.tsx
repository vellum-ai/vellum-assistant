import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import type { DiskPressureStatus } from "@vellumai/assistant-api";

let nativeAndroid = false;

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
}));

// Simulates setLocalBool swallowing a failed storage write (private
// browsing, quota): the real helper catches the error and stores nothing.
let failStorageWrites = false;
const actualLocalSettings = await import("@/utils/local-settings");
// Snapshot before mock.module rebinds the namespace, or the wrapper below
// would call itself through the live binding.
const realSetLocalBool = actualLocalSettings.setLocalBool;

mock.module("@/utils/local-settings", () => ({
  ...actualLocalSettings,
  setLocalBool: (key: string, value: boolean) => {
    if (failStorageWrites) {
      return;
    }
    realSetLocalBool(key, value);
  },
}));

const { DiskPressureBannerSlot, useDiskPressureBannerVisibility } =
  await import("@/domains/chat/components/disk-pressure-banner-slot");

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

// Mirrors the chat route: one visibility instance feeds the slot.
function SlotHarness({ monitor }: { monitor: UseDiskPressureMonitorResult }) {
  const visibility = useDiskPressureBannerVisibility(monitor, "assistant-1");
  return (
    <MemoryRouter>
      <DiskPressureBannerSlot
        diskPressure={monitor}
        visibility={visibility}
        assistantStateKind="active"
      />
    </MemoryRouter>
  );
}

function renderSlot() {
  return render(<SlotHarness monitor={diskPressure} />);
}

// Mirrors the chat route's precedence wiring: the resource-pressure slot only
// gets the space when the disk banner is not actually visible.
function PrecedenceHarness({
  monitor,
}: {
  monitor: UseDiskPressureMonitorResult;
}) {
  const visibility = useDiskPressureBannerVisibility(monitor, "assistant-1");
  return (
    <MemoryRouter>
      <DiskPressureBannerSlot
        diskPressure={monitor}
        visibility={visibility}
        assistantStateKind="active"
      />
      {visibility.visibleMode !== null ? null : (
        <div data-testid="resource-banner-stand-in" />
      )}
    </MemoryRouter>
  );
}

beforeEach(() => {
  nativeAndroid = false;
  failStorageWrites = false;
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

  test("a dismissal still yields the slot when the storage write fails", () => {
    failStorageWrites = true;
    render(<PrecedenceHarness monitor={diskPressure} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // The shared visibility instance carries the in-memory dismissal even
    // though no storage notification fired, so the precedence gate frees
    // the space instead of suppressing both banners.
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
