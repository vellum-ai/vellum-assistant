import { afterAll, beforeEach, expect, mock, test } from "bun:test";

let native = true;
type ServerOptions = { server: string };
type StoreOptions = ServerOptions & { token: string };
const isAvailable = mock(async () => ({ available: true, biometryType: "biometric" }));
const storeToken = mock(async (_options: StoreOptions) => undefined);
const retrieveToken = mock(async (_options: ServerOptions) => ({ token: "session-token" }));
const deleteToken = mock(async (_options: ServerOptions) => undefined);

mock.module("@/runtime/native-auth", () => ({ isNativePlatform: () => native }));
mock.module("@capacitor/core", () => ({
  registerPlugin: () => ({
    isAvailable,
    storeToken,
    retrieveToken,
    deleteToken,
  }),
}));

const biometric = await import("@/runtime/native-biometric");
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

function setOrigin(origin: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, origin },
  });
}

function nativeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  native = true;
  setOrigin("https://www.vellum.ai");
  mock.clearAllMocks();
  isAvailable.mockResolvedValue({ available: true, biometryType: "biometric" });
  storeToken.mockResolvedValue(undefined);
  retrieveToken.mockResolvedValue({ token: "session-token" });
  deleteToken.mockResolvedValue(undefined);
});

afterAll(() => {
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
});

test("maps iOS and Android capability responses to appropriate labels", async () => {
  const cases = [
    ["faceId", "Face ID"],
    ["touchId", "Touch ID"],
    ["fingerprint", "your fingerprint"],
    ["face", "face recognition"],
    ["biometric", "biometrics"],
  ] as const;

  for (const [biometryType, label] of cases) {
    isAvailable.mockResolvedValueOnce({ available: true, biometryType });
    expect(await biometric.getBiometricCapability()).toMatchObject({
      type: biometryType,
      label,
    });
  }
});

test("fails open in browsers and older shells", async () => {
  native = false;
  expect((await biometric.getBiometricCapability()).available).toBe(false);

  native = true;
  const unsupported = new Error("not implemented");
  isAvailable.mockRejectedValueOnce(unsupported);
  storeToken.mockRejectedValueOnce(unsupported);
  retrieveToken.mockRejectedValueOnce(unsupported);
  expect((await biometric.getBiometricCapability()).available).toBe(false);
  expect(await biometric.storeBiometricToken("token")).toBe(false);
  expect(await biometric.retrieveBiometricToken()).toBeNull();
});

test("isolates storage by normalized effective server origin", async () => {
  setOrigin("HTTPS://WWW.VELLUM.AI:443");
  await biometric.storeBiometricToken("cloud-token");
  setOrigin("https://assistant.example.com:8443");
  await biometric.storeBiometricToken("self-hosted-token");

  expect(storeToken.mock.calls[0]?.[0].server).toBe("https://www.vellum.ai");
  expect(storeToken.mock.calls[1]?.[0].server).toBe(
    "https://assistant.example.com:8443",
  );
});

test("reads the legacy iOS cloud key without crossing self-hosted origins", async () => {
  retrieveToken.mockRejectedValueOnce(nativeError("TOKEN_NOT_FOUND"));
  retrieveToken.mockResolvedValueOnce({ token: "legacy-token" });
  expect(await biometric.retrieveBiometricToken()).toBe("legacy-token");
  expect(retrieveToken.mock.calls.map(([options]) => options.server)).toEqual([
    "https://www.vellum.ai",
    "vellum.ai",
  ]);

  setOrigin("https://preview.vellum.ai");
  retrieveToken.mockClear();
  retrieveToken.mockRejectedValueOnce(nativeError("TOKEN_NOT_FOUND"));
  expect(await biometric.retrieveBiometricToken()).toBeNull();
  expect(retrieveToken).toHaveBeenCalledTimes(1);

  await biometric.deleteBiometricToken();
  expect(deleteToken.mock.calls.map(([options]) => options.server)).toEqual([
    "https://preview.vellum.ai",
    "vellum.ai",
  ]);
});

test("cancellation keeps recovery enabled while invalidation disables it", async () => {
  biometric.setBiometricEnabled(true);
  retrieveToken.mockRejectedValueOnce(nativeError("AUTH_CANCELED"));
  expect(await biometric.retrieveBiometricToken()).toBeNull();
  expect(biometric.isBiometricEnabled()).toBe(true);

  retrieveToken.mockRejectedValueOnce(nativeError("KEY_INVALIDATED"));
  expect(await biometric.retrieveBiometricToken()).toBeNull();
  expect(biometric.isBiometricEnabled()).toBe(false);
});
