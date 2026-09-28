/**
 * Teleport settings card. Lets the user move the active assistant between
 * hosting environments (local / Docker / cloud), preserving the source until
 * the new one is confirmed working.
 *
 * The card itself carries the destination description and the launch button.
 * Confirmation, transfer progress, and the final Confirm & Switch step run in
 * modals over the page (`ConfirmDialog`, then `TeleportProgressModal`); a
 * failure lands back on the card as an inline notice so its message stays
 * readable next to the retry.
 *
 * Only the Electron host renders it (gated by the caller in `general-page.tsx`).
 * Both teleport directions are GA.
 */

import {
  Cloud,
  Container,
  Info,
  MonitorSmartphone,
  type LucideIcon,
} from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { resolveDesktopHostOS } from "@/runtime/platform-detection";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";

import { TeleportProgressModal } from "./teleport-progress-modal";
import {
  destinationDescriptionKey,
  destinationLabelKey,
  type TeleportDestination,
} from "./teleport-types";
import { useTeleport } from "./use-teleport";

/** Header glyph of the confirm dialog, one per destination. */
const DESTINATION_ICONS: Record<TeleportDestination, LucideIcon> = {
  local: MonitorSmartphone,
  docker: Container,
  platform: Cloud,
};

export function TeleportCard() {
  const { t } = useTranslation("settings");
  const teleport = useTeleport();
  const { destination, phase } = teleport;
  // Both directions go through the platform API (export/import signed URLs,
  // managed hatch), so the card needs a platform session either way.
  const platformGate = usePlatformGate();

  // No eligible destination for this assistant — leave teleport hidden, matching
  // the Swift picker which renders nothing for out-of-scope assistants.
  if (!destination || platformGate === "gated") {
    return null;
  }

  return (
    <DetailCard
      title={t("teleportCard.title")}
      subtitle={t("teleportCard.subtitle")}
    >
      {platformGate === "disabled" && (
        <PlatformLoginNotice>
          {t("teleportCard.loginNotice")}
        </PlatformLoginNotice>
      )}

      {platformGate === "full" && phase.kind !== "failed" && (
        <div className="flex flex-col gap-2">
          <p className="text-body-medium-default text-[var(--content-tertiary)]">
            {t(destinationDescriptionKey(destination, resolveDesktopHostOS()))}
          </p>
          <Button
            variant="outlined"
            className="self-start"
            disabled={phase.kind !== "idle"}
            onClick={teleport.requestTeleport}
          >
            {t(destinationLabelKey(destination))}
          </Button>
        </div>
      )}

      {phase.kind === "failed" && (
        <Notice
          tone="error"
          title={phase.error}
          actions={
            <Button variant="outlined" onClick={teleport.reset}>
              {t("teleportCard.tryAgain")}
            </Button>
          }
        />
      )}

      <ConfirmDialog
        open={teleport.confirmOpen}
        icon={DESTINATION_ICONS[destination]}
        title={t(destinationLabelKey(destination))}
        message={t("teleportCard.confirmMessage")}
        confirmLabel={t("teleportCard.confirmLabel")}
        cancelLabel={t("teleportCard.cancel")}
        onConfirm={teleport.confirm}
        onCancel={teleport.cancelConfirm}
      >
        <Notice
          tone="warning"
          icon={<Info className="h-4 w-4" aria-hidden="true" />}
          className="mt-3"
        >
          {t("teleportCard.confirmWarning")}
        </Notice>
      </ConfirmDialog>

      <TeleportProgressModal
        phase={phase}
        onConfirmAndSwitch={teleport.confirmAndSwitch}
        onCancel={teleport.cancelTeleport}
      />
    </DetailCard>
  );
}
