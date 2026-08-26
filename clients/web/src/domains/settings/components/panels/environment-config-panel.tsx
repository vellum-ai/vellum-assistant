import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import { useEnvironmentStore } from "@/stores/environment-store";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function EnvironmentConfigPanel() {
  const { t } = useTranslation("settings");
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const isNonProduction = useEnvironmentStore.use.isNonProduction();
  const setEnvironment = useEnvironmentStore.use.setEnvironment();

  return (
    <DetailCard
      title={t("environmentConfigPanel.title")}
      subtitle={t("environmentConfigPanel.subtitle")}
    >
      <div className="space-y-2">
        <div className="flex items-start gap-3 py-3">
          <div className="shrink-0 pt-0.5">
            <Toggle
              checked={isNonProduction}
              onChange={(next) => setEnvironment({ isNonProduction: next })}
              aria-label={
                isNonProduction
                  ? t("environmentConfigPanel.nonProductionOnAriaLabel")
                  : t("environmentConfigPanel.nonProductionOffAriaLabel")
              }
            />
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <span className="text-body-medium-default text-[var(--content-default)]">
              {t("environmentConfigPanel.nonProduction")}
            </span>
            <span className="block text-body-small-default text-[var(--content-tertiary)]">
              {t("environmentConfigPanel.nonProductionDescription")}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-3 py-3">
          <div className="shrink-0 pt-0.5">
            <Tag tone="neutral">{emailRootDomain}</Tag>
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <span className="text-body-medium-default text-[var(--content-default)]">
              {t("environmentConfigPanel.emailRootDomain")}
            </span>
            <span className="block text-body-small-default text-[var(--content-tertiary)]">
              {t("environmentConfigPanel.emailRootDomainDescription")}
            </span>
          </div>
        </div>
      </div>
    </DetailCard>
  );
}
