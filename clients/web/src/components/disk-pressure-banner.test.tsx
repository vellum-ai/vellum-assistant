import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { DiskPressureStatus } from "@vellumai/assistant-api";

const { DiskPressureBanner } = await import("@/components/disk-pressure-banner");

afterEach(() => {
  cleanup();
});

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

describe("DiskPressureBanner warning variant", () => {
  test("renders the storage-low copy and CTA labels", () => {
    const onUpgradeStorage = mock(() => {});
    const onReviewWorkspaceData = mock(() => {});

    render(
      <DiskPressureBanner
        status={warningStatus}
        mode="warning"
        onAcknowledge={() => {}}
        onUpgradeStorage={onUpgradeStorage}
        onReviewWorkspaceData={onReviewWorkspaceData}
      />,
    );

    expect(screen.getByText("Your storage is almost full")).toBeTruthy();
    expect(
      screen.getByText(
        "Free up space or add more storage to avoid interruptions.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage Storage" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
  });

  test("invokes onUpgradeStorage when Upgrade is clicked", () => {
    const onUpgradeStorage = mock(() => {});

    render(
      <DiskPressureBanner
        status={warningStatus}
        mode="warning"
        onAcknowledge={() => {}}
        onUpgradeStorage={onUpgradeStorage}
        onReviewWorkspaceData={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    expect(onUpgradeStorage).toHaveBeenCalledTimes(1);
  });
});
