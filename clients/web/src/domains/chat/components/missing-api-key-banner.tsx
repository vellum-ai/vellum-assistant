import { X } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface MissingApiKeyBannerProps {
  onOpenSettings: () => void;
  onDismiss: () => void;
}

export function MissingApiKeyBanner({
  onOpenSettings,
  onDismiss,
}: MissingApiKeyBannerProps) {
  const { t } = useTranslation("chat");
  return (
    <div
      className="relative flex flex-col gap-3 bg-[var(--surface-active)] p-4"
      style={{ borderRadius: "10px 10px 0 0" }}
      role="status"
      aria-label={t("missingApiKeyBanner.ariaLabel")}
      data-testid="missing-api-key-banner"
    >
      <div className="absolute right-2 top-2">
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          tooltip={t("missingApiKeyBanner.dismiss")}
          aria-label={t("missingApiKeyBanner.dismissAria")}
          onClick={onDismiss}
        />
      </div>

      <div className="flex flex-col gap-2 pr-8">
        <p className="text-body-small-emphasised text-[var(--content-default)]">
          {t("missingApiKeyBanner.title")}
        </p>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          {t("missingApiKeyBanner.body")}
        </p>
      </div>

      <Button variant="primary" onClick={onOpenSettings}>
        {t("missingApiKeyBanner.openSettings")}
      </Button>
    </div>
  );
}
