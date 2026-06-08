import type { NavigateFunction } from "react-router";

import { getOnboardingEntrypoint } from "@/domains/onboarding/gate";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import {
  getActiveAssistant,
  isLocalAssistant,
  isLocalMode,
} from "@/lib/local-mode";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

export async function handleLogout(navigate: NavigateFunction): Promise<void> {
  if (isLocalMode()) {
    const active = getActiveAssistant();
    if (active && isLocalAssistant(active)) {
      await setMenuPlatformSession(false);
      useAuthStore.setState({ platformSession: "absent" });
      return;
    }

    await setMenuPlatformSession(false);
    await useAuthStore.getState().logout();
    navigate(getOnboardingEntrypoint());
  } else {
    await useAuthStore.getState().logout();
    hardNavigate(routes.account.login);
  }
}
