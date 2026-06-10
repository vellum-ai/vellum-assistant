import { useEffect, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { getLaunchAtLogin, setLaunchAtLogin } from "@/runtime/launch-at-login";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function LaunchAtLoginCard() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    getLaunchAtLogin().then(setEnabled);
  }, []);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    try {
      await setLaunchAtLogin(next);
    } catch {
      setEnabled(!next);
    }
  };

  return (
    <DetailCard
      title="Launch at Login"
      subtitle="Automatically start Vellum when you log in to your Mac."
    >
      <Toggle checked={enabled} onChange={(next) => void handleToggle(next)} />
    </DetailCard>
  );
}
