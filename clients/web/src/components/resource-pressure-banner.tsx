import { Activity } from "lucide-react";
import { useState } from "react";

import { Button, Checkbox, Notice } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface ResourcePressureBannerProps {
  /**
   * The assistant's display name, used in the title. Null or blank falls
   * back to the generic title copy.
   */
  assistantName: string | null;
  /**
   * Called when the user dismisses the banner. The `permanent` flag is true
   * when the user also checked "Don't show again"; in that case the caller
   * should suppress the banner permanently, not just for the cooldown period.
   */
  onDismiss: (permanent: boolean) => void;
  /**
   * Navigates to the plans page. Null hides the Upgrade button and drops
   * the body's upgrade clause (native Android and non-active assistants).
   */
  onUpgrade: (() => void) | null;
}

export function ResourcePressureBanner(props: ResourcePressureBannerProps) {
  const { assistantName, onDismiss, onUpgrade } = props;
  const { t } = useTranslation();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const trimmedName = assistantName?.trim();
  const title = trimmedName
    ? t("resourcePressureBanner.titleNamed", { assistantName: trimmedName })
    : t("resourcePressureBanner.title");

  // Which signal tripped and how hard is deliberately not surfaced; the
  // banner is a plan-headroom nudge, not a metrics readout.
  const body = onUpgrade
    ? t("resourcePressureBanner.body")
    : t("resourcePressureBanner.bodyNoUpgrade");

  return (
    <Notice
      tone="warning"
      title={title}
      icon={<Activity className="h-4 w-4" aria-hidden="true" />}
      onDismiss={() => onDismiss(dontShowAgain)}
      className="p-4"
      data-testid="resource-pressure-banner"
    >
      <div className="flex flex-col gap-3">
        <p className="m-0">{body}</p>
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
