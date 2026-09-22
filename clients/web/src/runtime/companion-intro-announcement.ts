import type { CompanionIntroAnnouncementAction } from "@vellumai/ipc-contract";

import { createBooleanBridgeStore } from "@/runtime/boolean-bridge-store";
import { isElectron } from "@/runtime/is-electron";

const bridge = () => (isElectron() ? window.vellum?.companion : undefined);

const announcement = createBooleanBridgeStore({
  getInitial: async () => (await bridge()?.getIntroAnnouncement?.()) ?? false,
  subscribe: (callback) =>
    bridge()?.onIntroAnnouncement?.(callback) ?? (() => undefined),
});

export function useCompanionIntroAnnouncement(): boolean {
  return announcement.useValue();
}

export function answerCompanionIntroAnnouncement(
  action: CompanionIntroAnnouncementAction,
): void {
  bridge()?.answerIntroAnnouncement?.(action);
}
