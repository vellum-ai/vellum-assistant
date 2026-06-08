/**
 * Tests for `getEffectiveTimezone`.
 *
 * Mocks the two collaborators (`getDeviceSetting`, `getBrowserTimezone`)
 * rather than touching real `localStorage`/`Intl`, so the resolver's
 * override-vs-auto branching is pinned in isolation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const getDeviceSettingMock = mock((_name: string, fallback: string) => fallback);
mock.module("@/utils/device-settings", () => ({
  getDeviceSetting: getDeviceSettingMock,
}));

const getBrowserTimezoneMock = mock(() => "America/Los_Angeles");
mock.module("@/utils/browser-timezone", () => ({
  getBrowserTimezone: getBrowserTimezoneMock,
}));

import { getEffectiveTimezone } from "./effective-timezone";

beforeEach(() => {
  getDeviceSettingMock.mockReset();
  getBrowserTimezoneMock.mockReset();
  getDeviceSettingMock.mockImplementation((_name, fallback) => fallback);
  getBrowserTimezoneMock.mockImplementation(() => "America/Los_Angeles");
});

describe("getEffectiveTimezone", () => {
  test("returns the device override when device:timezone is set", () => {
    getDeviceSettingMock.mockImplementation(() => "America/New_York");

    expect(getEffectiveTimezone()).toBe("America/New_York");
    expect(getBrowserTimezoneMock).not.toHaveBeenCalled();
  });

  test("trims surrounding whitespace from a real override", () => {
    getDeviceSettingMock.mockImplementation(() => "  Europe/London  ");

    expect(getEffectiveTimezone()).toBe("Europe/London");
  });

  test("falls back to the live browser zone when the override is empty", () => {
    expect(getEffectiveTimezone()).toBe("America/Los_Angeles");
    expect(getBrowserTimezoneMock).toHaveBeenCalledTimes(1);
  });

  test("treats a whitespace-only override as empty and falls back", () => {
    getDeviceSettingMock.mockImplementation(() => "   ");

    expect(getEffectiveTimezone()).toBe("America/Los_Angeles");
    expect(getBrowserTimezoneMock).toHaveBeenCalledTimes(1);
  });
});
