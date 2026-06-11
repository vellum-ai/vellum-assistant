import { useNavigate } from "react-router";

import { DetailCard } from "@/components/detail-card";
import { handleLogout } from "@/lib/auth/handle-logout";
import { isLocalMode } from "@/lib/local-mode";
import { useHasPlatformSession } from "@/stores/auth-store";
import { Button } from "@vellumai/design-library/components/button";

export function LogOutSection() {
  const navigate = useNavigate();
  // Mirror the Preferences popover's prior visibility gate so behavior is
  // preserved now that logout lives here (see `showLogout` in
  // `preferences-menu.tsx`): hide in pure local mode unless a platform
  // session exists.
  const hasPlatformSession = useHasPlatformSession();
  const showLogout = !isLocalMode() || hasPlatformSession;

  if (!showLogout) return null;

  return (
    <DetailCard
      title="Log Out"
      subtitle="Sign out of your Vellum account on this device."
    >
      <Button
        variant="outlined"
        onClick={() => void handleLogout(navigate)}
        className="self-start"
      >
        Log Out
      </Button>
    </DetailCard>
  );
}
