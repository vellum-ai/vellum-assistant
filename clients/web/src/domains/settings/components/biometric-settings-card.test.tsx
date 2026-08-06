import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let native = true;
let ios = false;
let capability = { available: true, type: "biometric", label: "biometrics" };

mock.module("@/runtime/native-auth", () => ({
  getSessionTokenFromCookies: () => "session-token",
  useIsNativePlatform: () => native,
}));
mock.module("@/runtime/platform-detection", () => ({
  useIsNativeIOS: () => ios,
}));
mock.module("@/runtime/native-biometric", () => ({
  getBiometricCapability: async () => capability,
  isBiometricEnabled: () => true,
  setBiometricEnabled: () => undefined,
  storeBiometricToken: async () => true,
  deleteBiometricToken: async () => undefined,
}));

const { BiometricSettingsCard } = await import("./biometric-settings-card");

beforeEach(() => {
  native = true;
  ios = false;
  capability = { available: true, type: "biometric", label: "biometrics" };
});
afterEach(cleanup);

test("preserves iOS copy with the device passcode fallback", async () => {
  ios = true;
  capability = { available: true, type: "faceId", label: "Face ID" };
  render(<BiometricSettingsCard />);
  expect(await screen.findByText("Use Face ID for sign-in")).toBeDefined();
  expect(screen.getByText(/or your device passcode/)).toBeDefined();
});

test("uses Android capability copy without a passcode fallback", async () => {
  capability.type = "fingerprint";
  capability.label = "your fingerprint";
  render(<BiometricSettingsCard />);
  expect(await screen.findByText(/Use your fingerprint/)).toBeDefined();
  expect(screen.queryByText(/device passcode/)).toBeNull();
});

test("stays hidden on browsers, older shells, and unsupported devices", async () => {
  capability = { available: false, type: "none", label: "biometrics" };
  const { container } = render(<BiometricSettingsCard />);
  await waitFor(() => expect(container.innerHTML).toBe(""));
});
