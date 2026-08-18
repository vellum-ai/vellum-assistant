import { Activity } from "lucide-react";
import { useState } from "react";

import type { ResourcePressureStatus } from "@vellumai/assistant-api";
import { Button, Checkbox, Notice } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface ResourcePressureBannerProps {
  status: ResourcePressureStatus;
  /**
   * Called when the user dismisses the banner. The `permanent` flag is true
   * when the user also checked "Don't show again"; in that case the caller
   * should suppress the banner permanently, not just for the cooldown period.
   */
  onDismiss: (permanent: boolean) => void;
  /**
   * Navigates to the plans page. Null hides the Upgrade button and its hint
   * (native Android and non-active assistants).
   */
  onUpgrade: (() => void) | null;
}

export function ResourcePressureBanner(props: ResourcePressureBannerProps) {
  const { status, onDismiss, onUpgrade } = props;
  const { t } = useTranslation();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const body =
    status.cpuElevated && status.memoryElevated
      ? t("resourcePressureBanner.bodyBoth")
      : status.memoryElevated
        ? t("resourcePressureBanner.bodyMemory")
        : t("resourcePressureBanner.bodyCpu");

  const readouts: string[] = [];
  if (status.cpuPercent != null && Number.isFinite(status.cpuPercent)) {
    readouts.push(
      t("resourcePressureBanner.cpuLabel", {
        value: Math.round(status.cpuPercent),
      }),
    );
  }
  if (status.memoryPercent != null && Number.isFinite(status.memoryPercent)) {
    readouts.push(
      t("resourcePressureBanner.memoryLabel", {
        value: Math.round(status.memoryPercent),
      }),
    );
  }

  return (
    <Notice
      tone="warning"
      title={t("resourcePressureBanner.title")}
      icon={<Activity className="h-4 w-4" aria-hidden="true" />}
      onDismiss={() => onDismiss(dontShowAgain)}
      className="p-4"
      data-testid="resource-pressure-banner"
    >
      <div className="flex flex-col gap-3">
        {readouts.length > 0 ? (
          <div className="flex items-center gap-3">
            {readouts.map((readout) => (
              <span
                key={readout}
                className="text-body-medium-default shrink-0 tabular-nums text-[color:var(--system-mid-strong)]"
              >
                {readout}
              </span>
            ))}
          </div>
        ) : null}
        <p className="m-0">{body}</p>
        {onUpgrade ? (
          <p className="m-0">{t("resourcePressureBanner.upgradeHint")}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {onUpgrade ? (
            <Button variant="outlined" size="compact" onClick={onUpgrade}>
              {t("resourcePressureBanner.upgrade")}
            </Button>
          ) : null}
          <Checkbox
            className="ml-auto"
            checked={dontShowAgain}
            onCheckedChange={(next) => setDontShowAgain(next === true)}
            label={t("resourcePressureBanner.dontShowAgain")}
            data-testid="resource-pressure-banner-dont-show-again"
          />
        </div>
      </div>
    </Notice>
  );
}
