import type { NavigateFunction } from "react-router";

import { getOnboardingEntrypoint } from "@/domains/onboarding/gate";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import {
  getActiveAssistant,
  isLocalAssistant,
  isLocalClient,
} from "@/lib/local-mode";
import { clearCompanionWorking } from "@/runtime/companion-surface";
import { setAssistantName } from "@/runtime/identity";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

export async function handleLogout(navigate: NavigateFunction): Promise<void> {
  if (isLocalClient()) {
    const active = getActiveAssistant();
    if (active && isLocalAssistant(active)) {
      await setMenuPlatformSession(false);
      useAuthStore.setState({ platformSession: "absent" });
      return;
    }

    await setMenuPlatformSession(false);
    await useAuthStore.getState().logout();
    // The same teardown the hosted path does below, and for the companion
    // surface it is not cosmetic: the published name is what tells main there
    // is an assistant to draw, so a name left standing keeps a floating pill
    // on the desktop of someone who has signed out of it.
    setAssistantName("");
    clearCompanionWorking();
    navigate(getOnboardingEntrypoint());
  } else {
    await useAuthStore.getState().logout();
    // Clear the published assistant name before the hard navigation. The hard
    // nav replaces the page synchronously, so no React unmount cleanup runs;
    // without this, Electron main keeps titling the signed-out window, tray,
    // and About panel with the previous assistant's name. No-op off Electron.
    setAssistantName("");
    // And for the same reason, stop the companion surface claiming a turn is
    // in flight. Signing out mid-turn would otherwise leave its working ring
    // travelling over a signed-out app, since the surface is opened by a flag
    // and the tray preference rather than by the window that was publishing.
    clearCompanionWorking();
    hardNavigate(routes.account.login);
  }
}
