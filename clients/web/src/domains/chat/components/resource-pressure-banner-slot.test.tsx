import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { UseResourcePressureMonitorResult } from "@/assistant/use-resource-pressure-monitor";
import type { ResourcePressureStatus } from "@vellumai/assistant-api";

let nativeAndroid = false;

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
}));

const navigateMock = mock((_to: string) => {});
const actualReactRouter = await import("react-router");

mock.module("react-router", () => ({
  ...actualReactRouter,
  useNavigate: () => navigateMock,
}));

const { ResourcePressureBannerSlot } = await import(
  "@/domains/chat/components/resource-pressure-banner-slot"
);
const { routes } = await import("@/utils/routes");
const { getResourcePressureMonitorMode } = await import(
  "@/assistant/resource-pressure"
);

const DISMISSED_UNTIL_KEY =
  "vellum:resourcePressureDismissedUntil:assistant-1";
const SUPPRESSED_KEY = "vellum:resourcePressureSuppressed:assistant-1";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const elevatedStatus: ResourcePressureStatus = {
  enabled: true,
  state: "elevated",
  cpuPercent: 96,
  memoryPercent: 91,
  cpuElevated: true,
  memoryElevated: true,
  cpuThresholdPercent: 90,
  memoryThresholdPercent: 90,
  lastCheckedAt: null,
  error: null,
};

const okStatus: ResourcePressureStatus = {
  ...elevatedStatus,
  state: "ok",
  cpuElevated: false,
  memoryElevated: false,
  cpuPercent: 12,
  memoryPercent: 35,
};

function monitorResult(
  status: ResourcePressureStatus | null,
): UseResourcePressureMonitorResult {
  return {
    status,
    mode: getResourcePressureMonitorMode(status),
  };
}

function slot(
  status: ResourcePressureStatus | null,
  assistantStateKind = "active",
) {
  return (
    <MemoryRouter>
      <ResourcePressureBannerSlot
        resourcePressure={monitorResult(status)}
        assistantId="assistant-1"
        assistantStateKind={assistantStateKind}
      />
    </MemoryRouter>
  );
}

function queryBanner() {
  return screen.queryByTestId("resource-pressure-banner");
}

beforeEach(() => {
  nativeAndroid = false;
  navigateMock.mockClear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("ResourcePressureBannerSlot", () => {
  test("renders nothing while the monitor is inactive", () => {
    render(slot(okStatus));

    expect(queryBanner()).toBeNull();
  });

  test("shows the banner with an Upgrade action for an active assistant", () => {
    render(slot(elevatedStatus));

    expect(queryBanner()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(navigateMock).toHaveBeenCalledWith(routes.plans);
  });

  test("hides the Upgrade action on native Android", () => {
    nativeAndroid = true;
    render(slot(elevatedStatus));

    expect(queryBanner()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  });

  test("hides the Upgrade action for non-active assistant states", () => {
    render(slot(elevatedStatus, "retired"));

    expect(queryBanner()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  });

  test("dismiss hides the banner and persists a 7-day cooldown", () => {
    render(slot(elevatedStatus));

    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const after = Date.now();

    expect(queryBanner()).toBeNull();
    const storedUntil = Number(localStorage.getItem(DISMISSED_UNTIL_KEY));
    expect(storedUntil).toBeGreaterThanOrEqual(before + WEEK_MS);
    expect(storedUntil).toBeLessThanOrEqual(after + WEEK_MS);
    expect(localStorage.getItem(SUPPRESSED_KEY)).toBeNull();
  });

  test("a still-valid cooldown suppresses a fresh elevated episode", () => {
    const view = render(slot(elevatedStatus));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    view.rerender(slot(okStatus));
    view.rerender(slot(elevatedStatus));

    expect(queryBanner()).toBeNull();

    // The cooldown also survives a reload (a fresh mount).
    cleanup();
    render(slot(elevatedStatus));
    expect(queryBanner()).toBeNull();
  });

  test("an expired cooldown shows the banner again", () => {
    localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() - 1000));
    render(slot(elevatedStatus));

    expect(queryBanner()).toBeTruthy();
  });

  test("permanent suppress persists and always hides the banner", () => {
    render(slot(elevatedStatus));

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Don't show again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(queryBanner()).toBeNull();
    expect(localStorage.getItem(SUPPRESSED_KEY)).toBe("true");
    expect(localStorage.getItem(DISMISSED_UNTIL_KEY)).toBeNull();

    cleanup();
    render(slot(elevatedStatus));
    expect(queryBanner()).toBeNull();
  });
});
