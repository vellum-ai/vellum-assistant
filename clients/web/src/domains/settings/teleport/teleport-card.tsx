/**
 * Teleport settings card — the web/Electron port of the macOS
 * `TeleportSection.swift` UI. Lets the user move the active assistant between
 * hosting environments (local / Docker / cloud), preserving the source until
 * the new one is confirmed working.
 *
 * Rendered only when the `teleport` client feature flag is on AND the client is
 * the Electron host (gated by the caller in `general-page.tsx`).
 */

import { CheckCircle2, Loader2 } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";

import { destinationDescription, destinationLabel } from "./teleport-types";
import { useTeleport } from "./use-teleport";

export function TeleportCard() {
  const { t } = useTranslation("settings");
  const teleport = useTeleport();
  const { destination, phase } = teleport;

  // No eligible destination for this assistant — leave teleport hidden, matching
  // the Swift picker which renders nothing for out-of-scope assistants.
  if (!destination) {
    return null;
  }

  return (
    <DetailCard
      title={t("teleportCard.title")}
      subtitle={t("teleportCard.subtitle")}
    >
      {phase.kind === "idle" && (
        <div className="flex flex-col gap-2">
          <p className="text-body-medium-default text-[var(--content-tertiary)]">
            {destinationDescription(destination)}
          </p>
          <Button
            variant="outlined"
            className="self-start"
            onClick={teleport.requestTeleport}
          >
            {destinationLabel(destination)}
          </Button>
        </div>
      )}

      {phase.kind === "transferring" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {phase.progress == null && (
              <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
            )}
            <span className="text-body-medium-default text-[var(--content-tertiary)]">
              {phase.step}
            </span>
          </div>
          {phase.progress != null && (
            <ProgressBar
              value={phase.progress}
              aria-label={t("teleportCard.progressAriaLabel")}
              className="max-w-[240px]"
            />
          )}
        </div>
      )}

      {phase.kind === "verifying" && (
        <Notice
          tone="success"
          icon={<CheckCircle2 className="h-4 w-4" />}
          title={t("teleportCard.verifyTitle")}
          actions={
            <div className="flex gap-2">
              <Button variant="primary" onClick={teleport.confirmAndSwitch}>
                {t("teleportCard.confirmAndSwitch")}
              </Button>
              <Button variant="outlined" onClick={teleport.cancelTeleport}>
                {t("teleportCard.cancel")}
              </Button>
            </div>
          }
        />
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
        title={destinationLabel(destination)}
        message={t("teleportCard.confirmMessage")}
        confirmLabel={t("teleportCard.confirmLabel")}
        onConfirm={teleport.confirm}
        onCancel={teleport.cancelConfirm}
      />
    </DetailCard>
  );
}
