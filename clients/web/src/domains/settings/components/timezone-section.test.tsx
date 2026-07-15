/**
 * Tests for `TimezoneSection`, the timezone editor inside the Profile card.
 *
 * Strategy: render `TimezoneSection` directly (the full Profile card pulls in
 * many feature-flag/query dependencies). Mock the generated API client's
 * `patch`, `setDeviceSetting`, `captureError`, and stub `TimezonePicker` with
 * a minimal harness that exposes its `onChange` via buttons. Drive the active
 * assistant id through the real selection store. Assert that an explicit zone
 * change PATCHes `{ ui: { userTimezone: "<zone>" } }`, auto/clear PATCHes
 * `{ ui: { userTimezone: "" } }`, and that with no assistant id the device
 * setting is still written but no PATCH is attempted.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

interface PatchArgs {
  url: string;
  path: { assistant_id: string };
  body: { ui: Record<string, unknown> };
}

const ZONE = "America/Los_Angeles";

const patchMock = mock(async (_args: PatchArgs) => ({ data: {} }));
const setDeviceSettingMock = mock((_name: string, _value: string) => {});
const captureErrorMock = mock(
  (_error: unknown, _opts: { context: string }) => {},
);

mock.module("@/generated/api/client.gen", () => ({
  client: {
    patch: patchMock,
    getConfig: () => ({ baseUrl: "http://test.local" }),
  },
}));

mock.module("@/utils/device-settings", () => ({
  DEVICE_PREFIX: "device:",
  deviceKey: (name: string) => `device:${name}`,
  getDeviceSetting: (_name: string, fallback: string) => fallback,
  setDeviceSetting: setDeviceSettingMock,
  getDeviceBool: (_name: string, fallback: boolean) => fallback,
  setDeviceBool: () => {},
  watchDeviceSetting: () => () => {},
  migrateDeviceSettings: () => {},
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

// Minimal picker harness: exposes the `onChange` handler through buttons so
// the test can drive an explicit zone pick and an auto/clear ("") without
// re-implementing the real picker's debounce / Intl logic.
mock.module("@/domains/settings/components/timezone-picker", () => ({
  TimezonePicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <div>
      <button type="button" onClick={() => onChange(ZONE)}>
        pick-zone
      </button>
      <button type="button" onClick={() => onChange("")}>
        pick-auto
      </button>
      <button type="button" onClick={() => onChange("Europe/Paris")}>
        pick-paris
      </button>
      <button type="button" onClick={() => onChange("Asia/Tokyo")}>
        pick-tokyo
      </button>
    </div>
  ),
}));

const { TimezoneSection } = await import("@/domains/settings/components/timezone-section");

beforeEach(() => {
  patchMock.mockClear();
  setDeviceSettingMock.mockClear();
  captureErrorMock.mockClear();
  patchMock.mockImplementation(async () => ({ data: {} }));
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("TimezoneSection", () => {
  test("explicit zone change PATCHes ui.userTimezone and writes the device setting", () => {
    const { getByText } = render(<TimezoneSection />);
    fireEvent.click(getByText("pick-zone"));

    expect(setDeviceSettingMock).toHaveBeenCalledWith("timezone", ZONE);
    expect(patchMock).toHaveBeenCalledTimes(1);
    const call = patchMock.mock.calls[0]![0];
    expect(call.url).toBe("/v1/assistants/{assistant_id}/config");
    expect(call.path).toEqual({ assistant_id: "asst-1" });
    expect(call.body).toEqual({ ui: { userTimezone: ZONE } });
  });

  test("selecting auto/clear PATCHes ui.userTimezone with an empty string", () => {
    const { getByText } = render(<TimezoneSection />);
    fireEvent.click(getByText("pick-auto"));

    expect(setDeviceSettingMock).toHaveBeenCalledWith("timezone", "");
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0]![0].body).toEqual({
      ui: { userTimezone: "" },
    });
  });

  test("with no assistant id, writes the device setting and skips the PATCH", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const { getByText } = render(<TimezoneSection />);
    fireEvent.click(getByText("pick-zone"));

    expect(setDeviceSettingMock).toHaveBeenCalledWith("timezone", ZONE);
    expect(patchMock).not.toHaveBeenCalled();
  });

  test("serializes rapid override changes (last-writer-wins): the final value is the last write and no two PATCHes overlap", async () => {
    // Hold every PATCH pending so we can observe overlap (or the lack of it)
    // while several changes fire in quick succession.
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    patchMock.mockImplementation(
      () =>
        new Promise<{ data: Record<string, unknown> }>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight -= 1;
            resolve({ data: {} });
          });
        }),
    );

    const { getByText } = render(<TimezoneSection />);

    // Three rapid changes. The first starts a PATCH; the next two only update
    // the pending target while the first is in flight.
    fireEvent.click(getByText("pick-zone")); // America/Los_Angeles
    fireEvent.click(getByText("pick-paris")); // Europe/Paris
    fireEvent.click(getByText("pick-tokyo")); // Asia/Tokyo (last writer)

    // Local device setting is written synchronously for every change.
    expect(setDeviceSettingMock).toHaveBeenLastCalledWith(
      "timezone",
      "Asia/Tokyo",
    );

    // Only ONE PATCH is in flight despite three changes.
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0]![0].body).toEqual({
      ui: { userTimezone: ZONE },
    });
    expect(maxInFlight).toBe(1);

    // Settle the first PATCH → the queue drains to the LAST requested value,
    // skipping the intermediate one entirely.
    resolvers[0]!();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(patchMock.mock.calls[1]![0].body).toEqual({
      ui: { userTimezone: "Asia/Tokyo" },
    });
    expect(maxInFlight).toBe(1);

    // Settle the drained PATCH; no further writes follow.
    resolvers[1]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  test("a queued override after an assistant switch targets the CURRENT assistant, not the one active when the change started", async () => {
    // Hold the first PATCH pending so we can switch assistants and queue a
    // second change while it is in flight.
    const resolvers: Array<() => void> = [];
    patchMock.mockImplementation(
      () =>
        new Promise<{ data: Record<string, unknown> }>((resolve) => {
          resolvers.push(() => resolve({ data: {} }));
        }),
    );

    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-A" });
    const { getByText, rerender } = render(<TimezoneSection />);

    // (a) Start a change for assistant A: the first PATCH fires and stays in
    // flight.
    fireEvent.click(getByText("pick-zone")); // America/Los_Angeles
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0]![0].path).toEqual({ assistant_id: "asst-A" });

    // (b) Switch the active assistant to B and re-render so `assistantIdRef`
    // picks up the new id via its effect.
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-B" });
    rerender(<TimezoneSection />);

    // (c) Change the timezone again while A's PATCH is still in flight: this
    // only records the pending value (no second PATCH yet).
    fireEvent.click(getByText("pick-tokyo")); // Asia/Tokyo
    expect(patchMock).toHaveBeenCalledTimes(1);

    // Settle A's PATCH → the queue drains. The drained write must target the
    // CURRENT assistant (B), carrying the latest requested value.
    resolvers[0]!();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(patchMock.mock.calls[1]![0].path).toEqual({ assistant_id: "asst-B" });
    expect(patchMock.mock.calls[1]![0].body).toEqual({
      ui: { userTimezone: "Asia/Tokyo" },
    });

    // No write ever went to A carrying B's requested value.
    const wroteTokyoToA = patchMock.mock.calls.some(
      (call) =>
        call[0].path.assistant_id === "asst-A" &&
        call[0].body.ui.userTimezone === "Asia/Tokyo",
    );
    expect(wroteTokyoToA).toBe(false);

    resolvers[1]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(2);
  });
});
