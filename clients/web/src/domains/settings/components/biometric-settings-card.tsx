import { useEffect, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { getSessionTokenFromCookies, useIsNativePlatform } from "@/runtime/native-auth";
import {
    deleteBiometricToken,
    getBiometricTypeLabel,
    isBiometricAvailable,
    isBiometricEnabled,
    setBiometricEnabled,
    storeBiometricToken,
} from "@/runtime/native-biometric";
import { Toggle } from "@vellumai/design-library/components/toggle";

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
