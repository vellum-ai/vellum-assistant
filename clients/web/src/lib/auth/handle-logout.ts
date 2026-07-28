import type { NavigateFunction } from "react-router";

import { getOnboardingEntrypoint } from "@/domains/onboarding/gate";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import {
  getActiveAssistant,
  isLocalAssistant,
  isLocalMode,
} from "@/lib/local-mode";
import { setAssistantName } from "@/runtime/identity";
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
    // Clear the published assistant name before the hard navigation. The hard
    // nav replaces the page synchronously, so no React unmount cleanup runs;
    // without this, Electron main keeps titling the signed-out window, tray,
    // and About panel with the previous assistant's name. No-op off Electron.
    setAssistantName("");
    hardNavigate(routes.account.login);
  }
}
