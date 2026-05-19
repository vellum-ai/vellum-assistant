import { registerPlugin } from "@capacitor/core";

import { isNativePlatform } from "@/runtime/native-auth.js";

/**
 * JS ↔ native bridge for the `NativeBiometric` Capacitor plugin registered by
 * `web/ios/App/App/MyViewController.swift` +
 * `web/ios/App/App/NativeBiometricPlugin.swift`.
 *
 * The plugin provides biometric-protected Keychain storage for session tokens,
 * enabling Face ID / Touch ID session recovery without a full WorkOS login.
 *
 * Biometric login is enabled by default on devices that support it. Users
 * can opt out via Settings → Privacy. The preference is stored in
 * localStorage under `BIOMETRIC_ENABLED_KEY`.
 *
 * References:
 * - https://developer.apple.com/documentation/localauthentication/accessing_keychain_items_with_face_id_or_touch_id
 * - https://developer.apple.com/documentation/security/secaccesscontrolcreateflags
 */

interface NativeBiometricPlugin {
  isAvailable(): Promise<{
    available: boolean;
    biometryType: "faceId" | "touchId" | "opticId" | "none";
  }>;
  storeToken(opts: { token: string; server: string }): Promise<void>;
  retrieveToken(opts: {
    server: string;
    reason?: string;
  }): Promise<{ token: string }>;
  deleteToken(opts: { server: string }): Promise<void>;
}

const NativeBiometric = registerPlugin<NativeBiometricPlugin>("NativeBiometric");

const BIOMETRIC_SERVER = "vellum.ai";
const BIOMETRIC_ENABLED_KEY = "vellum_biometric_enabled";

/**
 * Check whether biometric authentication is available on this device.
 * Returns `false` on non-native platforms without throwing.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    const { available } = await NativeBiometric.isAvailable();
    return available;
  } catch {
    return false;
  }
}

/**
 * Store a session token in the Keychain protected by biometrics.
 * Returns `true` on success, `false` if biometrics are unavailable or
 * the Keychain write fails. Callers should only persist the biometric
 * preference when this returns `true`.
 */
export async function storeBiometricToken(token: string): Promise<boolean> {
  if (!(await isBiometricAvailable())) return false;
  try {
    await NativeBiometric.storeToken({ token, server: BIOMETRIC_SERVER });
    return true;
  } catch (err) {
    console.error("[native-biometric] failed to store token:", err);
    return false;
  }
}

/**
 * Attempt to retrieve a session token via biometric authentication.
 * iOS presents the Face ID / Touch ID prompt automatically when the
 * Keychain item is accessed.
 *
 * Returns `null` if no token is stored, biometrics fail, or the user
 * cancels the prompt.
 */
let pendingRetrieval: Promise<string | null> | null = null;

export async function retrieveBiometricToken(): Promise<string | null> {
  if (!isNativePlatform()) return null;
  if (pendingRetrieval) return pendingRetrieval;

  pendingRetrieval = (async () => {
    try {
      const { token } = await NativeBiometric.retrieveToken({
        server: BIOMETRIC_SERVER,
        reason: "Sign in to Vellum",
      });
      return token;
    } catch {
      return null;
    } finally {
      pendingRetrieval = null;
    }
  })();

  return pendingRetrieval;
}

/**
 * Delete any stored biometric session token. Called on logout to ensure
 * the next app launch requires a fresh WorkOS login.
 */
export async function deleteBiometricToken(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await NativeBiometric.deleteToken({ server: BIOMETRIC_SERVER });
  } catch {
    // Ignore — token may not exist.
  }
}

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

/**
 * Whether biometric session recovery is enabled. Defaults to `true` on
 * native platforms — users must explicitly opt out via Settings → Privacy.
 */
export function isBiometricEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(BIOMETRIC_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Persist the biometric login preference. */
export function setBiometricEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(BIOMETRIC_ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    // Best-effort persistence.
  }
}

/** Returns the biometric type label (e.g. "Face ID", "Touch ID"). */
export async function getBiometricTypeLabel(): Promise<string> {
  if (!isNativePlatform()) return "Biometrics";
  try {
    const { biometryType } = await NativeBiometric.isAvailable();
    switch (biometryType) {
      case "faceId":
        return "Face ID";
      case "touchId":
        return "Touch ID";
      case "opticId":
        return "Optic ID";
      default:
        return "Biometrics";
    }
  } catch {
    return "Biometrics";
  }
}
