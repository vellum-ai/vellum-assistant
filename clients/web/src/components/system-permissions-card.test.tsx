import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionStatus,
  SystemPermissionsState,
} from "@/runtime/system-permissions";

let state: SystemPermissionsState;

const openSystemPermissionSettings = mock(async () => null);
const requestSystemPermission = mock(async () => null);
const refresh = mock(async () => state);
const setDockBadge = mock(() => undefined);

function item(
  kind: SystemPermissionKind,
  status: SystemPermissionStatus,
): SystemPermissionStateItem {
  return {
    kind,
    status,
    canRequest: status !== "granted" && status !== "restricted",
    canOpenSettings: status !== "granted",
    requiresRestart: false,
  };
}

function makeState(
  overrides: Partial<Record<SystemPermissionKind, SystemPermissionStatus>> = {},
): SystemPermissionsState {
  return {
    accessibility: item("accessibility", overrides.accessibility ?? "denied"),
    screen: item("screen", overrides.screen ?? "denied"),
    microphone: item("microphone", overrides.microphone ?? "denied"),
    speechRecognition: item(
      "speechRecognition",
      overrides.speechRecognition ?? "denied",
    ),
    inputMonitoring: item(
      "inputMonitoring",
      overrides.inputMonitoring ?? "denied",
    ),
    automation: item("automation", overrides.automation ?? "unknown"),
    notifications: item("notifications", overrides.notifications ?? "denied"),
  };
}

mock.module("@/runtime/system-permissions", () => ({
  useSystemPermissionsState: () => ({
    state,
    loading: false,
    error: null,
    supported: true,
    refresh,
  }),
  openSystemPermissionSettings,
  requestSystemPermission,
}));

mock.module("@/runtime/dock", () => ({
  setDockBadge,
}));

const { SystemPermissionsCard } = await import("./system-permissions-card");

beforeEach(() => {
  state = makeState();
  localStorage.clear();
  openSystemPermissionSettings.mockClear();
  requestSystemPermission.mockClear();
  refresh.mockClear();
  setDockBadge.mockClear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SystemPermissionsCard", () => {
  test("does not mirror Notification Badges from the Notifications permission", () => {
    state = makeState({ notifications: "granted" });
    localStorage.setItem("device:dock_badges_enabled", "false");

    render(<SystemPermissionsCard />);

    expect(
      screen.getByRole("switch", { name: "Notifications" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("switch", { name: "Notification Badges" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
  });

  test("updates the Dock badge setting without requesting a macOS permission", async () => {
    localStorage.setItem("device:dock_badges_enabled", "true");

    render(<SystemPermissionsCard />);

    fireEvent.click(screen.getByRole("switch", { name: "Notification Badges" }));

    await waitFor(() => {
      expect(localStorage.getItem("device:dock_badges_enabled")).toBe("false");
    });
    expect(setDockBadge).toHaveBeenCalledWith(0);
    expect(openSystemPermissionSettings).not.toHaveBeenCalled();
    expect(requestSystemPermission).not.toHaveBeenCalled();
  });
});
