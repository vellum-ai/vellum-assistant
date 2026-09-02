import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import * as identity from "@/lib/local-platform-identity";
import * as actualToast from "@vellumai/design-library/components/toast";

import type { PlatformGateState } from "@/hooks/use-platform-gate";

let platformGate: PlatformGateState = "full";
const recoverMock = mock(async () => {});
const loginMock = mock(async () => {});
const toastSuccess = mock((_message: string) => {});
const toastError = mock((_message: string) => {});

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => platformGate,
}));

mock.module("@/hooks/use-onboarding-login", () => ({
  useOnboardingLogin: () => ({
    loading: false,
    error: null,
    login: loginMock,
    cancel: mock(() => {}),
  }),
}));

mock.module("@/lib/local-platform-identity", () => ({
  ...identity,
  recoverLocalAssistantPlatformCredential: recoverMock,
}));

// The design-library barrel re-exports this module in full, so the stub keeps
// its other exports and replaces only the notifier.
mock.module("@vellumai/design-library/components/toast", () => ({
  ...actualToast,
  toast: { success: toastSuccess, error: toastError },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const { RestoreManagedCredentialButton } =
  await import("./restore-managed-credential-button");

function renderButton(onRestored = mock(() => {})) {
  render(
    <MemoryRouter>
      <RestoreManagedCredentialButton onRestored={onRestored} />
    </MemoryRouter>,
  );
  return { onRestored, button: screen.getByRole("button") };
}

beforeEach(() => {
  platformGate = "full";
  recoverMock.mockReset();
  recoverMock.mockImplementation(async () => {});
  loginMock.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("RestoreManagedCredentialButton", () => {
  test("with a platform session, a press runs the repair and retires the banner on success", async () => {
    const { onRestored, button } = renderButton();

    fireEvent.click(button);

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  // The repair rotates the credential through the platform, so without a
  // session it would fail after the press. The slot asks for the sign-in
  // first instead of offering a repair that cannot run.
  test("without a platform session, the slot offers the sign-in and never starts the repair", async () => {
    platformGate = "disabled";
    const { onRestored, button } = renderButton();

    fireEvent.click(button);

    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
    expect(recoverMock).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  // A failed repair leaves the banner in place to try again, and the reader
  // gets the typed reason, never the thrown text.
  test("a typed failure reports it and keeps the banner", async () => {
    recoverMock.mockImplementation(async () => {
      throw new identity.LocalPlatformCredentialRecoveryError(
        "replacement_rejected",
        "platform said no",
      );
    });
    const { onRestored, button } = renderButton();

    fireEvent.click(button);

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).not.toContain("platform said no");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });
});
