import { X } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export type ApiKeyBannerVariant = "missing" | "invalid";

export interface MissingApiKeyBannerProps {
  variant?: ApiKeyBannerVariant;
  onOpenSettings: () => void;
  onDismiss: () => void;
  onUseDefaultModel?: () => void;
  useDefaultModelPending?: boolean;
}

export function MissingApiKeyBanner({
  variant = "missing",
  onOpenSettings,
  onDismiss,
  onUseDefaultModel,
  useDefaultModelPending = false,
}: MissingApiKeyBannerProps) {
  const { t } = useTranslation("chat");
  const invalid = variant === "invalid";
  const showUseDefault = invalid && typeof onUseDefaultModel === "function";

  return (
    <div
      className="relative flex flex-col gap-3 bg-[var(--surface-active)] p-4"
      style={{ borderRadius: "10px 10px 0 0" }}
      role="status"
      aria-label={
        invalid
          ? t("invalidApiKeyBanner.ariaLabel")
          : t("missingApiKeyBanner.ariaLabel")
      }
      data-testid={
        invalid ? "invalid-api-key-banner" : "missing-api-key-banner"
      }
    >
      <div className="absolute right-2 top-2">
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          tooltip={
            invalid
              ? t("invalidApiKeyBanner.dismiss")
              : t("missingApiKeyBanner.dismiss")
          }
          aria-label={
            invalid
              ? t("invalidApiKeyBanner.dismissAria")
              : t("missingApiKeyBanner.dismissAria")
          }
          onClick={onDismiss}
        />
      </div>

      <div className="flex flex-col gap-2 pr-8">
        <p className="text-body-small-emphasised text-[var(--content-default)]">
          {invalid
            ? t("invalidApiKeyBanner.title")
            : t("missingApiKeyBanner.title")}
        </p>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          {invalid
            ? t("invalidApiKeyBanner.body")
            : t("missingApiKeyBanner.body")}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={onOpenSettings}>
          {invalid
            ? t("invalidApiKeyBanner.openSettings")
            : t("missingApiKeyBanner.openSettings")}
        </Button>
        {showUseDefault && (
          <Button
            variant="outlined"
            onClick={onUseDefaultModel}
            disabled={useDefaultModelPending}
          >
            {t("invalidApiKeyBanner.useDefaultModel")}
          </Button>
        )}
      </div>
    </div>
  );
}
