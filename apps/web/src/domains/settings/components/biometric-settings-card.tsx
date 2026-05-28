import { useEffect, useState } from "react";

import { Toggle } from "@vellum/design-library/components/toggle";
import { DetailCard } from "@/components/detail-card";
import { deriveAuthBaseURL, useIsNativePlatform } from "@/runtime/native-auth";
import {
  deleteBiometricToken,
  getBiometricTypeLabel,
  isBiometricAvailable,
  isBiometricEnabled,
  readNativeSessionCookie,
  setBiometricEnabled,
  storeBiometricToken,
} from "@/runtime/native-biometric";

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
        // The session cookie is HttpOnly, so we read it through the
        // native plugin instead of `document.cookie`. Skip flipping the
        // preference if we can't capture a token — otherwise the user
        // would think biometrics is on, but no token would be in the
        // Keychain for recovery later.
        const token = await readNativeSessionCookie(deriveAuthBaseURL());
        if (!token) return;
        const stored = await storeBiometricToken(token);
        if (!stored) return;
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
    <DetailCard title="Security">
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
          onChange={() => void handleToggle()}
          disabled={toggling}
        />
      </div>
    </DetailCard>
  );
}
