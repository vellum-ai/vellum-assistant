import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

let native = true;
let ios = false;
let enabled = true;
let capability = {
  available: true,
  type: "biometric",
  label: "biometrics",
};
const setBiometricEnabled = mock((value: boolean) => {
  enabled = value;
});
const storeBiometricToken = mock(async () => true);
const deleteBiometricToken = mock(async () => undefined);

mock.module("@/runtime/native-auth", () => ({
  getSessionTokenFromCookies: () => "session-token",
  useIsNativePlatform: () => native,
}));
mock.module("@/runtime/platform-detection", () => ({
  useIsNativeIOS: () => ios,
}));
mock.module("@/runtime/native-biometric", () => ({
  getBiometricCapability: async () => capability,
  isBiometricEnabled: () => enabled,
  setBiometricEnabled,
  storeBiometricToken,
  deleteBiometricToken,
}));

const { BiometricSettingsCard } = await import("./biometric-settings-card");

beforeEach(() => {
  native = true;
  ios = false;
  enabled = true;
  capability = {
    available: true,
    type: "biometric",
    label: "biometrics",
  };
  setBiometricEnabled.mockClear();
  storeBiometricToken.mockClear();
  deleteBiometricToken.mockClear();
});

afterEach(cleanup);

describe("BiometricSettingsCard", () => {
  test("preserves iOS copy with the device passcode fallback", async () => {
    ios = true;
    capability = { available: true, type: "faceId", label: "Face ID" };
    render(<BiometricSettingsCard />);
    expect(await screen.findByText("Use Face ID for sign-in")).toBeDefined();
    expect(screen.getByText(/or your device passcode/)).toBeDefined();
  });

  test("uses the Android capability copy without a passcode fallback", async () => {
    capability = {
      available: true,
      type: "fingerprint",
      label: "your fingerprint",
    };
    render(<BiometricSettingsCard />);
    expect(
      await screen.findByText("Use your fingerprint for sign-in"),
    ).toBeDefined();
    expect(screen.queryByText(/device passcode/)).toBeNull();
  });

  test("stays hidden on browsers, older shells, and unsupported devices", async () => {
    native = false;
    const { container, rerender } = render(<BiometricSettingsCard />);
    expect(container.innerHTML).toBe("");

    native = true;
    capability = { available: false, type: "none", label: "biometrics" };
    rerender(<BiometricSettingsCard />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  test("turns recovery off and deletes the stored credential", async () => {
    render(<BiometricSettingsCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    await waitFor(() => expect(deleteBiometricToken).toHaveBeenCalledTimes(1));
    expect(setBiometricEnabled).toHaveBeenCalledWith(false);
  });
});
