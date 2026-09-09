import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { isPreviewRequested, setPreviewRequested } from "@/lib/preview-channel";

let staff = true;

mock.module("@/lib/auth/staff", () => ({
  isVellumStaff: () => staff,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }) } },
}));

mock.module("@/assistant/api", () => ({
  getAssistant: () =>
    Promise.resolve({
      ok: true,
      data: { id: "assistant-1", is_local: false, maintenance_mode: false },
    }),
}));

mock.module("react-router", () => ({
  useNavigate: () => () => {},
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "disabled",
}));

// The panel's other sections mount assistant-scoped data surfaces that are not
// under test here, so they are stubbed down to nothing.
mock.module("@/domains/settings/components/restart-assistant", () => ({
  RestartAssistant: () => null,
}));
mock.module("@/domains/settings/components/recovery-mode-controls", () => ({
  RecoveryModeControls: () => null,
}));
mock.module("@/domains/settings/components/assistant-backups", () => ({
  AssistantBackups: () => null,
}));
mock.module("@/components/platform-login-notice", () => ({
  PlatformLoginNotice: () => null,
}));

// The design-library barrel re-exports these alongside `toast`, so a partial
// stub surfaces as an "export not found" parse error during barrel resolution.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: () => {}, success: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { DebugControlsPanel } = await import("./debug-controls-panel");

let reloads = 0;
window.location.reload = () => {
  reloads += 1;
};

async function renderPanel() {
  const result = render(<DebugControlsPanel />);
  await waitFor(() => {
    expect(screen.getByText("Restart Assistant")).toBeDefined();
  });
  return result;
}

beforeEach(() => {
  staff = true;
  reloads = 0;
  setPreviewRequested(false);
});

afterEach(() => {
  cleanup();
  setPreviewRequested(false);
});

describe("DebugControlsPanel preview channel", () => {
  test("opts a staff user in and reloads", async () => {
    await renderPanel();

    const toggle = screen.getByRole("switch", {
      name: "Preview channel is off",
    });
    fireEvent.click(toggle);

    expect(isPreviewRequested()).toBe(true);
    expect(reloads).toBe(1);
  });

  test("opts a staff user back out", async () => {
    setPreviewRequested(true);
    await renderPanel();

    fireEvent.click(
      screen.getByRole("switch", { name: "Preview channel is on" }),
    );

    expect(isPreviewRequested()).toBe(false);
    expect(reloads).toBe(1);
  });

  test("reports the requested and running channels", async () => {
    setPreviewRequested(true);
    await renderPanel();

    expect(screen.getByText("Requested: preview")).toBeDefined();
    expect(screen.getByText("Running: stable build unknown")).toBeDefined();
    expect(
      screen.getByText(
        "No preview build is being served, so this browser is still on stable. Delete the vellum_preview cookie in devtools to reset.",
      ),
    ).toBeDefined();
  });

  test("hides the section from non-staff users", async () => {
    staff = false;
    await renderPanel();

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Requested: stable")).toBeNull();
  });
});
