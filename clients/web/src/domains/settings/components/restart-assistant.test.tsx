import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const restartLocalAssistantMock = mock(async () => ({
  ok: false,
  reason: "guardian_repair_required" as const,
}));
const repairLocalAssistantAfterRestartMock = mock(
  async (): Promise<{
    ok: boolean;
    reason?: "repair_failed";
    error?: string;
  }> => ({ ok: true }),
);
const toastErrorMock = mock(() => {});
const captureErrorMock = mock(() => {});

mock.module("@/lib/local-mode", () => ({
  isCliWakeableAssistant: () => true,
  restartLocalAssistant: restartLocalAssistantMock,
  repairLocalAssistantAfterRestart: repairLocalAssistantAfterRestartMock,
}));

mock.module("@/runtime/local-mode-host", () => ({
  isLocalModeHostAvailable: () => true,
}));

mock.module("@/assistant/api", () => ({
  restartAssistant: mock(async () => ({ ok: true })),
}));

mock.module("@/i18n", () => ({
  t: (key: string) =>
    ({
      "settings:restartAssistant.repairConfirmLabel": "Repair connection",
      "settings:restartAssistant.repairFailed": "Repair failed",
      "settings:restartAssistant.repairMessage":
        "Repairing signs out other browsers and devices.",
      "settings:restartAssistant.repairTitle": "Repair connection?",
      "settings:restartAssistant.reconnectFailed": "Reconnect failed",
    })[key] ?? key,
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

mock.module("@vellumai/design-library/components/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    message: ReactNode;
    confirmLabel: ReactNode;
    onConfirm: () => void;
  }) =>
    open ? (
      <div>
        <h2>{title}</h2>
        <p>{message}</p>
        <button onClick={onConfirm}>{confirmLabel}</button>
      </div>
    ) : null,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: mock(() => {}), error: toastErrorMock },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { RestartAssistant } = await import("./restart-assistant");

beforeEach(() => {
  restartLocalAssistantMock.mockClear();
  repairLocalAssistantAfterRestartMock.mockClear();
  repairLocalAssistantAfterRestartMock.mockImplementation(async () => ({
    ok: true,
  }));
  toastErrorMock.mockClear();
  captureErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
});

test("confirms guardian repair separately after restart authentication fails", async () => {
  render(<RestartAssistant assistantId="local-a" isLocal={true} />);

  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Restart" })[1]);

  expect(
    await screen.findByText("Repairing signs out other browsers and devices."),
  ).toBeTruthy();
  expect(repairLocalAssistantAfterRestartMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Repair connection" }));

  await waitFor(() =>
    expect(repairLocalAssistantAfterRestartMock).toHaveBeenCalledWith(
      "local-a",
    ),
  );
});

test("logs repair details but shows a localized failure", async () => {
  repairLocalAssistantAfterRestartMock.mockImplementation(async () => ({
    ok: false,
    reason: "repair_failed",
    error: "low-level host failure",
  }));
  render(<RestartAssistant assistantId="local-a" isLocal={true} />);

  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Restart" })[1]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Repair connection" }),
  );

  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Repair failed"));
  expect(captureErrorMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("low-level host failure")).toBeNull();
});
