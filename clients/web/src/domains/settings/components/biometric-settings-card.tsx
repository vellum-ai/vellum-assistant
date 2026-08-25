import { useEffect, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import {
  getSessionTokenFromCookies,
  useIsNativePlatform,
} from "@/runtime/native-auth";
import {
  deleteBiometricToken,
  getBiometricCapability,
  isBiometricEnabled,
  setBiometricEnabled,
  storeBiometricToken,
  type BiometricCapability,
} from "@/runtime/native-biometric";
import { useIsNativeIOS } from "@/runtime/platform-detection";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function BiometricSettingsCard() {
  const { t } = useTranslation("settings");
  const isNative = useIsNativePlatform();
  const isNativeIOS = useIsNativeIOS();
  const [enabled, setEnabled] = useState(() => isBiometricEnabled());
  const [capability, setCapability] = useState<BiometricCapability | null>(
    null,
  );
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!isNative) {
      return;
    }
    let active = true;
    void getBiometricCapability().then((result) => {
      if (active) {
        setCapability(result);
      }
    });
    return () => {
      active = false;
    };
  }, [isNative]);

  if (!isNative || !capability?.available) {
    return null;
  }

  const handleToggle = async () => {
    setToggling(true);
    try {
      const next = !enabled;
      if (next) {
        const token = getSessionTokenFromCookies();
        if (!token || !(await storeBiometricToken(token))) {
          setBiometricEnabled(false);
          setEnabled(false);
          return;
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
    <DetailCard title={t("biometricSettingsCard.title")}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-body-medium-default text-[var(--content-default)]">
            {t("biometricSettingsCard.useForSignIn", {
              label: capability.label,
            })}
          </div>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            {isNativeIOS
              ? t("biometricSettingsCard.descriptionWithPasscode", {
                  label: capability.label,
                })
              : t("biometricSettingsCard.description", {
                  label: capability.label,
                })}
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
