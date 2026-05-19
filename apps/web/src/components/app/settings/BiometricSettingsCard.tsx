
import { useEffect, useState } from "react";

import { Toggle } from "@vellum/design-library/components/toggle";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import { getSessionTokenFromCookies, useIsNativePlatform } from "@/lib/native-auth.js";
import {
  deleteBiometricToken,
  getBiometricTypeLabel,
  isBiometricAvailable,
  isBiometricEnabled,
  setBiometricEnabled,
  storeBiometricToken,
} from "@/lib/native-biometric.js";

/**
 * Settings card for opting out of biometric session recovery.
 * Biometric is enabled by default on supported devices; this toggle
 * lets users disable it. Only renders on native platforms where
 * biometrics are available.
 */
export function BiometricSettingsCard() {
  const isNative = useIsNativePlatform();
  const [enabled, setEnabled] = useState(() => isBiometricEnabled());
  const [available, setAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState("Face ID");
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!isNative) return;
    isBiometricAvailable().then(setAvailable);
    getBiometricTypeLabel().then(setBiometricLabel);
  }, [isNative]);

  if (!isNative || !available) return null;

  const handleToggle = async () => {
    setToggling(true);
    try {
      const next = !enabled;
      if (next) {
        // Store the current session token immediately so biometric
        // recovery works without waiting for the next login.
        const token = getSessionTokenFromCookies();
        if (token) {
          await storeBiometricToken(token);
        }
        setBiometricEnabled(true);
        setEnabled(true);
      } else {
        setBiometricEnabled(false);
        await deleteBiometricToken();
        setEnabled(false);
      }
    } finally {
      setToggling(false);
    }
  };

  return (
    <SettingsCard title="Security">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-body-medium-default text-[var(--content-default)]">
            Use {biometricLabel} for sign-in
          </div>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            When your session expires, verify with {biometricLabel} or your
            device passcode instead of signing in again.
          </p>
        </div>
        <Toggle
          checked={enabled}
          onChange={handleToggle}
          disabled={toggling}
          aria-label={`Use ${biometricLabel} for sign-in`}
        />
      </div>
    </SettingsCard>
  );
}
