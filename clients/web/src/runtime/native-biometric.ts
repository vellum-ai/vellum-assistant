import { registerPlugin } from "@capacitor/core";

import { isNativePlatform } from "@/runtime/native-auth";
import { getNativeUrlSchemeForHost } from "@/runtime/native-deep-link";
import { APEX_DOMAIN } from "@/utils/domains";
import { getDeviceBool, setDeviceBool } from "@/utils/device-settings";

export type BiometricType =
  | "faceId"
  | "touchId"
  | "opticId"
  | "fingerprint"
  | "face"
  | "biometric"
  | "none";

interface NativeBiometricPlugin {
  isAvailable(): Promise<{
    available: boolean;
    biometryType?: string;
  }>;
  storeToken(opts: { token: string; server: string }): Promise<void>;
  retrieveToken(opts: {
    server: string;
    reason?: string;
  }): Promise<{ token: string }>;
  deleteToken(opts: { server: string }): Promise<void>;
}

export interface BiometricCapability {
  available: boolean;
  type: BiometricType;
  label: string;
}

const NativeBiometric =
  registerPlugin<NativeBiometricPlugin>("NativeBiometric");

const BIOMETRIC_LABELS: Record<BiometricType, string> = {
  faceId: "Face ID",
  touchId: "Touch ID",
  opticId: "Optic ID",
  fingerprint: "your fingerprint",
  face: "face recognition",
  biometric: "biometrics",
  none: "biometrics",
};

const UNAVAILABLE_CAPABILITY: BiometricCapability = {
  available: false,
  type: "none",
  label: BIOMETRIC_LABELS.none,
};

function normalizeBiometryType(
  type: string | undefined,
  available: boolean,
): BiometricType {
  if (!available) {
    return "none";
  }
  if (type && type in BIOMETRIC_LABELS && type !== "none") {
    return type as BiometricType;
  }
  return "biometric";
}

function getBiometricServerOrigin(): string {
  return new URL(window.location.origin).origin;
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function biometricRetrievalServers(origin: string): string[] {
  return getNativeUrlSchemeForHost(new URL(origin).hostname)
    ? [origin, APEX_DOMAIN]
    : [origin];
}

export async function getBiometricCapability(): Promise<BiometricCapability> {
  if (!isNativePlatform()) {
    return UNAVAILABLE_CAPABILITY;
  }
  try {
    const result = await NativeBiometric.isAvailable();
    const type = normalizeBiometryType(result.biometryType, result.available);
    return {
      available: result.available,
      type,
      label: BIOMETRIC_LABELS[type],
    };
  } catch {
    return UNAVAILABLE_CAPABILITY;
  }
}

export async function storeBiometricToken(token: string): Promise<boolean> {
  if (!isNativePlatform()) {
    return false;
  }
  try {
    await NativeBiometric.storeToken({
      token,
      server: getBiometricServerOrigin(),
    });
    return true;
  } catch (error) {
    console.error("[native-biometric] failed to store token:", error);
    return false;
  }
}

let pendingRetrieval: Promise<string | null> | null = null;

async function retrieveTokenForServer(server: string): Promise<string> {
  const { token } = await NativeBiometric.retrieveToken({
    server,
    reason: "Sign in to Vellum",
  });
  return token;
}

/**
 * Attempt to retrieve a session token via biometric authentication.
 * The native shell presents its biometric prompt when protected storage is accessed.
 *
 * Returns `null` if no token is stored, biometrics fail, or the user
 * cancels the prompt.
 */
export async function retrieveBiometricToken(): Promise<string | null> {
  if (!isNativePlatform()) {
    return null;
  }
  if (pendingRetrieval) {
    return pendingRetrieval;
  }

  pendingRetrieval = (async () => {
    for (const server of biometricRetrievalServers(
      getBiometricServerOrigin(),
    )) {
      try {
        return await retrieveTokenForServer(server);
      } catch (error) {
        const code = nativeErrorCode(error);
        if (code === "KEY_INVALIDATED") {
          setBiometricEnabled(false);
        }
        if (code !== "TOKEN_NOT_FOUND") {
          return null;
        }
      }
    }
    return null;
  })().finally(() => {
    pendingRetrieval = null;
  });

  return pendingRetrieval;
}

/**
 * Delete any stored biometric session token. Called on logout to ensure
 * the next app launch requires a fresh WorkOS login.
 */
export async function deleteBiometricToken(): Promise<void> {
  if (!isNativePlatform()) {
    return;
  }

  for (const server of [getBiometricServerOrigin(), APEX_DOMAIN]) {
    try {
      await NativeBiometric.deleteToken({ server });
    } catch {
      // Missing plugins and absent credentials are safe to ignore during logout.
    }
  }
}

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

export function isBiometricEnabled(): boolean {
  return getDeviceBool("biometricEnabled", true);
}

/** Persist the biometric login preference. */
export function setBiometricEnabled(enabled: boolean): void {
  setDeviceBool("biometricEnabled", enabled);
}
