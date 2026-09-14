import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionStatus,
  SystemPermissionsState,
} from "@/runtime/system-permissions";

let state: SystemPermissionsState | null;
let supported = true;
let unreadBadgeSurface = "Dock icon";
let unreadBadgesSupported = true;
let hostOS: "macos" | "windows" = "macos";
let pushAvatarSender = true;
let selectedAssistantId: string | null = "assistant-a";
let ownerScopeId: string | null = `scope:v1:${"a".repeat(64)}`;
let preparedSnapshot: {
  name?: string;
  avatar?: { avatarBase64: string; avatarHash: string };
} | null = {
  name: "Alice",
  avatar: {
    avatarBase64: Buffer.from("avatar-bytes").toString("base64"),
    avatarHash: "b".repeat(64),
  },
};
const assistants = [
  {
    id: "assistant-a",
    isLocal: false,
    isPlatformHosted: true,
    isPaired: false,
  },
];

const openSystemPermissionSettings = mock(async () => null);
const requestSystemPermission = mock(async () => null);
const refresh = mock(async () => state);
const setDockBadge = mock(() => undefined);
const resolveAssistantAvatarOwnerScopeId = mock(() => ownerScopeId);

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
    supported,
    refresh,
  }),
  openSystemPermissionSettings,
  requestSystemPermission,
}));

mock.module("@/runtime/dock", () => ({
  getUnreadBadgeSurface: () => unreadBadgeSurface,
  setDockBadge,
  supportsUnreadBadges: () => unreadBadgesSupported,
}));

mock.module("@/runtime/platform-detection", () => ({
  detectElectronHostOS: () => hostOS,
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: { pushAvatarSender: () => pushAvatarSender },
  },
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: {
      selectedAssistantId: () => selectedAssistantId,
      assistants: () => assistants,
    },
  },
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({ kind: "platform", id: "account-123" }),
    },
  },
}));

mock.module("@/stores/organization-store", () => ({
  useRequestOrganizationId: () => "org-abc",
}));

mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedIngressUrl: () => null,
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  resolveAssistantAvatarOwnerScopeId,
  resolveAssistantNotificationPlatformId: () =>
    "123e4567-e89b-42d3-a456-426614174000",
}));

mock.module("@/runtime/notification-avatar", () => ({
  createNotificationIdentity: (
    scopeId: string,
    assistantId: string,
    platformAssistantId: string,
  ) => ({
    scopeId,
    assistantId,
    nativeSenderId: platformAssistantId,
  }),
  getNotificationIdentitySnapshot: () => preparedSnapshot,
}));

const { SystemPermissionsCard } = await import("./system-permissions-card");

beforeEach(() => {
  state = makeState();
  supported = true;
  unreadBadgeSurface = "Dock icon";
  unreadBadgesSupported = true;
  hostOS = "macos";
  pushAvatarSender = true;
  selectedAssistantId = "assistant-a";
  ownerScopeId = `scope:v1:${"a".repeat(64)}`;
  preparedSnapshot = {
    name: "Alice",
    avatar: {
      avatarBase64: Buffer.from("avatar-bytes").toString("base64"),
      avatarHash: "b".repeat(64),
    },
  };
  localStorage.clear();
  openSystemPermissionSettings.mockClear();
  requestSystemPermission.mockClear();
  refresh.mockClear();
  setDockBadge.mockClear();
  resolveAssistantAvatarOwnerScopeId.mockClear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SystemPermissionsCard", () => {
  test("shows the taskbar badge control without a permissions bridge", () => {
    state = null;
    supported = false;
    unreadBadgeSurface = "taskbar icon";

    render(<SystemPermissionsCard />);

    expect(
      screen.getByRole("switch", { name: "Notification Badges" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/unseen conversation counts on the taskbar icon/),
    ).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Accessibility" })).toBeNull();
  });

  test("does not mirror Notification Badges from the Notifications permission", () => {
    state = makeState({ notifications: "granted" });
    localStorage.setItem("device:dock_badges_enabled", "false");

    render(<SystemPermissionsCard />);

    expect(
      screen
        .getByRole("switch", { name: "Notifications" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "Notification Badges" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("shows only Windows-meaningful rows with Windows copy on a Windows host", () => {
    hostOS = "windows";

    render(<SystemPermissionsCard />);

    expect(screen.queryByRole("switch", { name: "Accessibility" })).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Screen Recording" }),
    ).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Microphone" })).toBeTruthy();
    expect(
      screen.getByText(/show Windows notifications for approvals/),
    ).toBeTruthy();
    expect(screen.queryByText(/macOS alerts/)).toBeNull();
  });

  test("hides permissions reported as not applicable", () => {
    state = makeState({ screen: "not-applicable" });

    render(<SystemPermissionsCard />);

    expect(
      screen.queryByRole("switch", { name: "Screen Recording" }),
    ).toBeNull();
  });

  test("updates the Dock badge setting without requesting a macOS permission", async () => {
    localStorage.setItem("device:dock_badges_enabled", "true");

    render(<SystemPermissionsCard />);

    fireEvent.click(
      screen.getByRole("switch", { name: "Notification Badges" }),
    );

    await waitFor(() => {
      expect(localStorage.getItem("device:dock_badges_enabled")).toBe("false");
    });
    expect(setDockBadge).toHaveBeenCalledWith(0);
    expect(openSystemPermissionSettings).not.toHaveBeenCalled();
    expect(requestSystemPermission).not.toHaveBeenCalled();
  });

  test("captures the exact prepared sender for a macOS notifications request", async () => {
    state = makeState({ notifications: "not-determined" });

    render(<SystemPermissionsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "Notifications" }));

    await waitFor(() => {
      expect(requestSystemPermission).toHaveBeenCalledTimes(1);
    });
    expect(resolveAssistantAvatarOwnerScopeId).toHaveBeenCalledWith(
      assistants[0],
      "account-123",
      "org-abc",
      expect.any(String),
    );
    expect(requestSystemPermission).toHaveBeenCalledWith("notifications", {
      presentation: "assistant",
      identity: {
        scopeId: ownerScopeId,
        assistantId: "assistant-a",
        nativeSenderId: "123e4567-e89b-42d3-a456-426614174000",
      },
      sender: {
        id: "123e4567-e89b-42d3-a456-426614174000",
        name: "Alice",
        avatarBase64: preparedSnapshot!.avatar!.avatarBase64,
        avatarHash: preparedSnapshot!.avatar!.avatarHash,
      },
    });
  });

  test("keeps notifications requests plain when the flag is off", async () => {
    state = makeState({ notifications: "not-determined" });
    pushAvatarSender = false;

    render(<SystemPermissionsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "Notifications" }));

    await waitFor(() => {
      expect(requestSystemPermission).toHaveBeenCalledWith("notifications");
    });
    expect(requestSystemPermission.mock.calls[0]).toHaveLength(1);
    expect(resolveAssistantAvatarOwnerScopeId).not.toHaveBeenCalled();
  });

  test("keeps notifications requests plain without a complete snapshot", async () => {
    state = makeState({ notifications: "not-determined" });
    preparedSnapshot = { name: "Alice" };

    render(<SystemPermissionsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "Notifications" }));

    await waitFor(() => {
      expect(requestSystemPermission).toHaveBeenCalledWith("notifications");
    });
    expect(requestSystemPermission.mock.calls[0]).toHaveLength(1);
  });

  test("leaves other permission requests unchanged", async () => {
    state = makeState({ microphone: "not-determined" });

    render(<SystemPermissionsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "Microphone" }));

    await waitFor(() => {
      expect(requestSystemPermission).toHaveBeenCalledWith("microphone");
    });
    expect(requestSystemPermission.mock.calls[0]).toHaveLength(1);
    expect(resolveAssistantAvatarOwnerScopeId).not.toHaveBeenCalled();
  });
});
