/**
 * Tests for `TimezoneCard` in the Settings General page.
 *
 * Strategy: render `TimezoneCard` directly (the full `GeneralPage` pulls in
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

import { useAssistantSelectionStore } from "@/assistant/selection-store";

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

const { TimezoneCard } = await import("@/domains/settings/pages/general-page");

beforeEach(() => {
  patchMock.mockClear();
  setDeviceSettingMock.mockClear();
  captureErrorMock.mockClear();
  patchMock.mockImplementation(async () => ({ data: {} }));
  useAssistantSelectionStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  useAssistantSelectionStore.setState({ activeAssistantId: null });
});

describe("TimezoneCard", () => {
  test("explicit zone change PATCHes ui.userTimezone and writes the device setting", () => {
    const { getByText } = render(<TimezoneCard />);
    fireEvent.click(getByText("pick-zone"));

    expect(setDeviceSettingMock).toHaveBeenCalledWith("timezone", ZONE);
    expect(patchMock).toHaveBeenCalledTimes(1);
    const call = patchMock.mock.calls[0]![0];
    expect(call.url).toBe("/v1/assistants/{assistant_id}/config");
    expect(call.path).toEqual({ assistant_id: "asst-1" });
    expect(call.body).toEqual({ ui: { userTimezone: ZONE } });
  });

  test("selecting auto/clear PATCHes ui.userTimezone with an empty string", () => {
    const { getByText } = render(<TimezoneCard />);
    fireEvent.click(getByText("pick-auto"));

    expect(setDeviceSettingMock).toHaveBeenCalledWith("timezone", "");
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0]![0].body).toEqual({
      ui: { userTimezone: "" },
    });
  });

  test("with no assistant id, writes the device setting and skips the PATCH", () => {
    useAssistantSelectionStore.setState({ activeAssistantId: null });
    const { getByText } = render(<TimezoneCard />);
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

    const { getByText } = render(<TimezoneCard />);

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
});
