import { toast } from "@vellumai/design-library/components/toast";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { t } from "@/i18n";
import { revealDownload } from "@/runtime/downloads";
import { detectElectronHostOS } from "@/runtime/platform-detection";

/**
 * The one consumer of the `download.*` bus signals: every user-visible
 * outcome of a Download action lives here, so the copy and the per-host
 * wording cannot drift between surfaces.
 *
 * Which signal fires is decided where it originates (see the `saveFile`
 * transport seam and `packages/electron-desktop/src/downloads.ts`), so this
 * hook never asks which host it is on beyond the file-manager label:
 *
 * - `download.started`: plain browser only. Acknowledge the handoff and point
 *   at the browser's own downloads UI, the only honest claim that host allows.
 * - `download.done`: pushed by Electron main after the file actually
 *   finished (or failed) saving, and by `saveFile` when the source could not
 *   be fetched or staged before any host handoff (a failed URL fetch on
 *   Electron; a failed fetch or cache write on the Capacitor save path). A
 *   completed report carries the reveal id for a "Show in Finder" /
 *   "Show in File Explorer" action.
 * - Capacitor iOS/Android otherwise publish nothing: a presented share
 *   sheet is the platform's own feedback and dismissing it must not claim a
 *   file was saved.
 *
 * Mounted once by `RootLayout`, alongside the bus init that wires the
 * underlying event sources.
 */
export function useDownloadFeedback(): void {
  useBusSubscription("download.started", ({ filename }) => {
    toast.info(t("downloadFeedback.started"), {
      description: t("downloadFeedback.startedDescription", { filename }),
    });
  });

  useBusSubscription("download.done", ({ id, filename, state }) => {
    if (state === "interrupted") {
      toast.error(t("downloadFeedback.failed"), { description: filename });
      return;
    }
    toast.success(t("downloadFeedback.saved"), {
      description: filename,
      ...(id !== undefined && {
        action: {
          label:
            detectElectronHostOS() === "windows"
              ? t("downloadFeedback.revealWindows")
              : t("downloadFeedback.revealMac"),
          onClick: () => {
            void revealDownload(id);
          },
        },
      }),
    });
  });
}
