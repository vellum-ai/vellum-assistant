import { useCallback, useEffect, useState } from "react";

import {
  isElectron,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
  type SystemPermissionsState,
} from "@/runtime/is-electron";
import {
  detectElectronHostOS,
  type ElectronHostOS,
} from "@/runtime/platform-detection";

export type {
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionStatus,
  SystemPermissionsState,
} from "@/runtime/is-electron";

export const SYSTEM_PERMISSION_KINDS: SystemPermissionKind[] = [
  "accessibility",
  "screen",
  "microphone",
  "speechRecognition",
  "inputMonitoring",
  "automation",
  "notifications",
];

/**
 * Deep links a host's own settings UI answers, per host. A host with no
 * scheme of its own carries an empty map rather than being left out of the
 * type, so the no-op is a stated fact instead of a missing case: Linux
 * desktops share no settings URI scheme, so nothing is routed there.
 */
const SYSTEM_PERMISSION_SETTINGS_URLS: Readonly<
  Record<ElectronHostOS, Readonly<Record<string, SystemPermissionKind>>>
> = {
  windows: {
    "ms-settings:privacy-microphone": "microphone",
    "ms-settings:privacy-speech": "speechRecognition",
    "ms-settings:privacy-graphicscaptureprogrammatic": "screen",
    "ms-settings:notifications": "notifications",
  },
  macos: {
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone":
      "microphone",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition":
      "speechRecognition",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture":
      "screen",
  },
  linux: {},
};

export function supportsSystemPermissions(): boolean {
  return (
    isElectron() && typeof window.vellum?.permissions?.getState === "function"
  );
}

export async function getSystemPermissionsState(): Promise<SystemPermissionsState | null> {
  if (!supportsSystemPermissions()) {
    return null;
  }
  return await window.vellum!.permissions!.getState();
}

export async function requestSystemPermission(
  kind: SystemPermissionKind,
): Promise<SystemPermissionStateItem | null> {
  if (!supportsSystemPermissions()) {
    return null;
  }
  return await window.vellum!.permissions!.request(kind);
}

export async function openSystemPermissionSettings(
  kind: SystemPermissionKind,
): Promise<SystemPermissionStateItem | null> {
  if (!supportsSystemPermissions()) {
    return null;
  }
  return await window.vellum!.permissions!.openSettings(kind);
}

export type SystemPermissionSettingsUrlOutcome =
  | "opened"
  | "ignored"
  | "unrecognized";

export function dispatchSystemPermissionSettingsUrl(
  url: string,
): SystemPermissionSettingsUrlOutcome {
  const owner = (
    Object.keys(SYSTEM_PERMISSION_SETTINGS_URLS) as ElectronHostOS[]
  ).find((candidate) => url in SYSTEM_PERMISSION_SETTINGS_URLS[candidate]);
  if (!owner) {
    return "unrecognized";
  }
  if (detectElectronHostOS() !== owner || !supportsSystemPermissions()) {
    return "ignored";
  }
  void openSystemPermissionSettings(
    SYSTEM_PERMISSION_SETTINGS_URLS[owner][url]!,
  );
  return "opened";
}

export async function quitAndReopenForPermissions(): Promise<void> {
  if (!supportsSystemPermissions()) {
    return;
  }
  await window.vellum!.permissions!.quitAndReopen();
}

export function subscribeToSystemPermissions(
  callback: (state: SystemPermissionsState) => void,
): () => void {
  if (!supportsSystemPermissions()) {
    return () => undefined;
  }
  return window.vellum!.permissions!.onState(callback);
}

export function useSystemPermissionsState() {
  const [state, setState] = useState<SystemPermissionsState | null>(null);
  const [loading, setLoading] = useState(() => supportsSystemPermissions());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supportsSystemPermissions()) {
      setState(null);
      setLoading(false);
      return null;
    }

    setError(null);
    try {
      const next = await getSystemPermissionsState();
      setState(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supportsSystemPermissions()) {
      setLoading(false);
      setState(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    const unsubscribe = subscribeToSystemPermissions((next) => {
      if (active) {
        setState(next);
      }
    });

    void getSystemPermissionsState()
      .then((next) => {
        if (active) {
          setState(next);
        }
      })
      .catch((err) => {
        if (!active) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return {
    state,
    loading,
    error,
    supported: supportsSystemPermissions(),
    refresh,
  };
}
