import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let native = true;
type ServerOptions = { server: string };
type StoreOptions = ServerOptions & { token: string };
const isAvailable = mock(async () => ({
  available: true,
  biometryType: "biometric",
}));
const storeToken = mock(async (_options: StoreOptions) => undefined);
const retrieveToken = mock(async (_options: ServerOptions) => ({
  token: "session-token",
}));
const deleteToken = mock(async (_options: ServerOptions) => undefined);

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => native,
}));
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
  localStorage.clear();
  isAvailable.mockClear();
  isAvailable.mockImplementation(async () => ({
    available: true,
    biometryType: "biometric",
  }));
  storeToken.mockClear();
  storeToken.mockImplementation(async (_options) => undefined);
  retrieveToken.mockClear();
  retrieveToken.mockImplementation(async (_options) => ({
    token: "session-token",
  }));
  deleteToken.mockClear();
  deleteToken.mockImplementation(async (_options) => undefined);
});

afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
});

describe("native biometric runtime", () => {
  test("maps iOS and Android capability responses to appropriate labels", async () => {
    const cases = [
      ["faceId", "Face ID"],
      ["touchId", "Touch ID"],
      ["opticId", "Optic ID"],
      ["fingerprint", "your fingerprint"],
      ["face", "face recognition"],
      ["biometric", "biometrics"],
    ] as const;

    for (const [biometryType, label] of cases) {
      isAvailable.mockImplementationOnce(async () => ({
        available: true,
        biometryType,
      }));
      expect(await biometric.getBiometricCapability()).toEqual({
        available: true,
        type: biometryType,
        label,
      });
    }
  });

  test("fails open off native and when an older shell has no plugin", async () => {
    native = false;
    expect(await biometric.getBiometricCapability()).toMatchObject({
      available: false,
    });
    expect(await biometric.retrieveBiometricToken()).toBeNull();
    expect(isAvailable).not.toHaveBeenCalled();

    native = true;
    const notImplemented = new Error("not implemented");
    isAvailable.mockRejectedValueOnce(notImplemented);
    storeToken.mockRejectedValueOnce(notImplemented);
    retrieveToken.mockRejectedValueOnce(notImplemented);
    deleteToken.mockRejectedValue(notImplemented);
    expect(await biometric.getBiometricCapability()).toMatchObject({
      available: false,
    });
    expect(await biometric.storeBiometricToken("token")).toBe(false);
    expect(await biometric.retrieveBiometricToken()).toBeNull();
    expect(await biometric.deleteBiometricToken()).toBeUndefined();
  });

  test("isolates storage by normalized effective server origin", async () => {
    setOrigin("HTTPS://WWW.VELLUM.AI:443");
    await biometric.storeBiometricToken("cloud-token");
    setOrigin("https://assistant.example.com:8443");
    await biometric.storeBiometricToken("self-hosted-token");

    expect(storeToken.mock.calls.map(([options]) => options)).toEqual([
      { token: "cloud-token", server: "https://www.vellum.ai" },
      {
        token: "self-hosted-token",
        server: "https://assistant.example.com:8443",
      },
    ]);
  });

  test("reads the legacy iOS cloud key but never crosses self-hosted origins", async () => {
    retrieveToken.mockRejectedValueOnce(nativeError("TOKEN_NOT_FOUND"));
    retrieveToken.mockResolvedValueOnce({ token: "legacy-token" });
    expect(await biometric.retrieveBiometricToken()).toBe("legacy-token");
    expect(retrieveToken.mock.calls.map(([options]) => options.server)).toEqual(
      ["https://www.vellum.ai", "vellum.ai"],
    );

    setOrigin("https://assistant.example.com");
    retrieveToken.mockClear();
    retrieveToken.mockRejectedValueOnce(nativeError("TOKEN_NOT_FOUND"));
    expect(await biometric.retrieveBiometricToken()).toBeNull();
    expect(retrieveToken).toHaveBeenCalledTimes(1);
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
});
