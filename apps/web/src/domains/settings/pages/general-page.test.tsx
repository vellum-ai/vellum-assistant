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
import { cleanup, fireEvent, render } from "@testing-library/react";

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
});
