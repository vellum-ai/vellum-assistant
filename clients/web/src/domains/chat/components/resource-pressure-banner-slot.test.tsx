import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

// Simulates `setLocalNumber` swallowing a failed storage write (private
// browsing, quota): the real helper catches the error and stores nothing.
let failStorageWrites = false;
const actualLocalSettings = await import("@/utils/local-settings");
// Snapshot before mock.module rebinds the namespace, or the wrapper below
// would call itself through the live binding.
const realSetLocalNumber = actualLocalSettings.setLocalNumber;

mock.module("@/utils/local-settings", () => ({
  ...actualLocalSettings,
  setLocalNumber: (key: string, value: number) => {
    if (failStorageWrites) {
      return;
    }
    realSetLocalNumber(key, value);
  },
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
  assistantId: string | null = "assistant-1",
) {
  return (
    <MemoryRouter>
      <ResourcePressureBannerSlot
        resourcePressure={monitorResult(status)}
        assistantId={assistantId}
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
  failStorageWrites = false;
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

  test("dismiss keeps the banner hidden when storage writes fail", () => {
    failStorageWrites = true;
    const view = render(slot(elevatedStatus));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(queryBanner()).toBeNull();
    expect(localStorage.getItem(DISMISSED_UNTIL_KEY)).toBeNull();

    view.rerender(slot(okStatus));
    view.rerender(slot(elevatedStatus));
    expect(queryBanner()).toBeNull();
  });

  test("a dismissal in one mounted surface hides the other surface's banner", () => {
    render(
      <MemoryRouter>
        <ResourcePressureBannerSlot
          resourcePressure={monitorResult(elevatedStatus)}
          assistantId="assistant-1"
          assistantStateKind="active"
        />
        <ResourcePressureBannerSlot
          resourcePressure={monitorResult(elevatedStatus)}
          assistantId="assistant-1"
          assistantStateKind="active"
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByTestId("resource-pressure-banner")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);

    expect(screen.queryAllByTestId("resource-pressure-banner")).toHaveLength(0);
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

  test("a cooldown lapsing while mounted re-enables the banner", async () => {
    // A short synthetic deadline stands in for the 7-day cooldown; bun's
    // setSystemTime does not advance setTimeout, so the test rides a real
    // timer (same approach as use-tip-card.test).
    localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() + 60));
    render(slot(elevatedStatus));

    expect(queryBanner()).toBeNull();

    // No remount: the expiry timer clears the cooldown at the deadline. Its
    // fire time is scheduler-dependent, so poll rather than sleeping.
    await waitFor(
      () => {
        expect(queryBanner()).toBeTruthy();
      },
      { timeout: 4000 },
    );
  });

  test("cpu-only elevation shows the CPU body", () => {
    render(
      slot({
        ...elevatedStatus,
        memoryElevated: false,
        memoryPercent: 40,
      }),
    );

    expect(
      screen.getByText("CPU usage has stayed high for an extended period."),
    ).toBeTruthy();
  });

  test("both signals elevated shows the combined body", () => {
    render(slot(elevatedStatus));

    expect(
      screen.getByText(
        "CPU and memory usage have stayed high for an extended period.",
      ),
    ).toBeTruthy();
  });

  test("memory-only elevation shows the memory body", () => {
    render(
      slot({
        ...elevatedStatus,
        cpuElevated: false,
        cpuPercent: 20,
      }),
    );

    expect(
      screen.getByText("Memory usage has stayed high for an extended period."),
    ).toBeTruthy();
  });

  test("switching assistants re-derives dismissal from the new keys", () => {
    // GIVEN assistant-1's banner was just dismissed in memory, and
    // assistant-2 carries a stored permanent suppress
    localStorage.setItem(
      "vellum:resourcePressureSuppressed:assistant-2",
      "true",
    );
    const view = render(slot(elevatedStatus));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(queryBanner()).toBeNull();

    // THEN assistant-2's stored suppress governs after the switch
    view.rerender(slot(elevatedStatus, "active", "assistant-2"));
    expect(queryBanner()).toBeNull();

    // AND assistant-3, with no stored state, does not inherit assistant-1's
    // in-memory dismiss
    view.rerender(slot(elevatedStatus, "active", "assistant-3"));
    expect(queryBanner()).toBeTruthy();
  });

  test("a stored suppress applies once a null assistant id resolves", () => {
    localStorage.setItem(SUPPRESSED_KEY, "true");
    const view = render(slot(elevatedStatus, "active", null));

    view.rerender(slot(elevatedStatus, "active", "assistant-1"));
    expect(queryBanner()).toBeNull();
  });

  test("a checked but undismissed suppress box does not follow an assistant switch", () => {
    const view = render(slot(elevatedStatus, "active", "assistant-1"));

    // Check "Don't show again" on assistant-1 but switch away before
    // dismissing; the keyed banner remounts, so assistant-2's dismiss is a
    // plain cooldown, not a permanent suppress inherited from assistant-1.
    fireEvent.click(screen.getByRole("checkbox", { name: "Don't show again" }));
    view.rerender(slot(elevatedStatus, "active", "assistant-2"));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(queryBanner()).toBeNull();
    expect(
      localStorage.getItem("vellum:resourcePressureSuppressed:assistant-2"),
    ).toBeNull();
    expect(
      Number(
        localStorage.getItem(
          "vellum:resourcePressureDismissedUntil:assistant-2",
        ),
      ),
    ).toBeGreaterThan(Date.now());
    expect(localStorage.getItem(SUPPRESSED_KEY)).toBeNull();
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
