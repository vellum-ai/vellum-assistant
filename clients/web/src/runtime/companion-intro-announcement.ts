import type { CompanionIntroAnnouncementAction } from "@vellumai/ipc-contract";

import { createBooleanBridgeStore } from "@/runtime/boolean-bridge-store";
import { isElectron } from "@/runtime/is-electron";

const bridge = () => (isElectron() ? window.vellum?.companion : undefined);

let announcement: ReturnType<typeof createBooleanBridgeStore> | undefined;

function announcementStore(): ReturnType<typeof createBooleanBridgeStore> {
  announcement ??= createBooleanBridgeStore({
    getInitial: async () => (await bridge()?.getIntroAnnouncement?.()) ?? false,
    subscribe: (callback) =>
      bridge()?.onIntroAnnouncement?.(callback) ?? (() => undefined),
  });
  return announcement;
}

export function useCompanionIntroAnnouncement(): boolean {
  return announcementStore().useValue();
}

export function answerCompanionIntroAnnouncement(
  action: CompanionIntroAnnouncementAction,
): void {
  bridge()?.answerIntroAnnouncement?.(action);
}
