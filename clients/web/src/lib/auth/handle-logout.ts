import type { NavigateFunction } from "react-router";

import { getOnboardingEntrypoint } from "@/domains/onboarding/gate";
import { stopWatch } from "@/domains/chat/watch/watch-controller";
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
    // And end any watch session, for the same reason and with more riding on
    // it. `useCompanionMirror` stops one at unmount, which the hard navigation
    // below never reaches, so signing out mid-session would leave the
    // microphone and the socket to die with the page while the surface went on
    // burning its capture ring over a signed-out app. An indicator that claims
    // a screen is being read when it is not is the same harm as one that stays
    // dark during a real capture, and this is the moment a user is most likely
    // to be deliberately ending a session.
    //
    // Fully synchronous through to the IPC send: the stop closes the socket and
    // writes the store, the mirror's subscription runs in that same tick, and
    // `setContext` is a fire-and-forget `ipcRenderer.send`. Nothing here is
    // awaited, so the navigation below cannot outrun the publish.
    //
    // Before `clearCompanionWorking`, because stopping republishes the whole
    // context with `working` recomputed from the live stores. The other order
    // would let a turn still in flight put the ring back after the clear.
    stopWatch();
    // And for the same reason, stop the companion surface claiming a turn is
    // in flight. Signing out mid-turn would otherwise leave its working ring
    // travelling over a signed-out app, since the surface is opened by a flag
    // and the tray preference rather than by the window that was publishing.
    clearCompanionWorking();
    hardNavigate(routes.account.login);
  }
}
