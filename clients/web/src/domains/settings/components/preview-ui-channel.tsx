import { useCallback } from "react";

import { useTranslation } from "@/i18n";
import { isVellumStaff } from "@/lib/auth/staff";
import {
  getRunningChannel,
  isPreviewRequested,
  setPreviewRequested,
} from "@/lib/preview-channel";
import { useAuthStore } from "@/stores/auth-store";
import { Toggle } from "@vellumai/design-library/components/toggle";

/**
 * Staff-only switch between the stable and preview builds of this app. It
 * changes the interface this browser loads and leaves the assistant alone,
 * which is what separates it from the release channel above.
 */
export function PreviewUiChannel() {
  const { t } = useTranslation("settings");
  const user = useAuthStore.use.user();

  const handleToggle = useCallback((next: boolean) => {
    setPreviewRequested(next);
    window.location.reload();
  }, []);

  if (!isVellumStaff(user)) {
    return null;
  }

  const requested = isPreviewRequested();
  const running = getRunningChannel();
  const runningVersion =
    running.version ?? t("previewUiChannel.versionUnknown");

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-body-medium-default text-[var(--content-default)]">
          {t("previewUiChannel.title")}
        </p>
        <p className="text-body-small-lighter text-[var(--content-tertiary)]">
          {t("previewUiChannel.description")}
        </p>
        <p className="text-body-small-lighter text-[var(--content-tertiary)]">
          {t(
            running.channel === "preview"
              ? "previewUiChannel.runningPreview"
              : "previewUiChannel.runningStable",
            { version: runningVersion },
          )}
        </p>
        {requested && running.channel === "stable" && (
          <p className="text-body-small-lighter text-[var(--content-tertiary)]">
            {t("previewUiChannel.unavailableHint")}
          </p>
        )}
      </div>
      <div className="shrink-0">
        <Toggle
          checked={requested}
          onChange={handleToggle}
          aria-label={
            requested
              ? t("previewUiChannel.onAriaLabel")
              : t("previewUiChannel.offAriaLabel")
          }
        />
      </div>
    </div>
  );
}
