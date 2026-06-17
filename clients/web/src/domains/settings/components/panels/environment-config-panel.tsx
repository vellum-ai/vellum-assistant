import { DetailCard } from "@/components/detail-card";
import { useEnvironmentStore } from "@/stores/environment-store";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function EnvironmentConfigPanel() {
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const isNonProduction = useEnvironmentStore.use.isNonProduction();
  const setEnvironment = useEnvironmentStore.use.setEnvironment();

  return (
    <DetailCard
      title="Environment"
      subtitle="Environment configuration overrides for this session."
    >
      <div className="space-y-2">
        <div className="flex items-start gap-3 py-3">
          <div className="shrink-0 pt-0.5">
            <Toggle
              checked={isNonProduction}
              onChange={(next) =>
                setEnvironment({ isNonProduction: next })
              }
              aria-label={`Non-Production is ${isNonProduction ? "on" : "off"}`}
            />
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <span className="text-body-medium-default text-[var(--content-default)]">
              Non-Production
            </span>
            <span className="block text-body-small-default text-[var(--content-tertiary)]">
              Indicates a non-production environment. Enables dev-only UI surfaces and diagnostics.
            </span>
          </div>
        </div>
        <div className="flex items-start gap-3 py-3">
          <div className="shrink-0 pt-0.5">
            <Tag tone="neutral">{emailRootDomain}</Tag>
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <span className="text-body-medium-default text-[var(--content-default)]">
              Email Root Domain
            </span>
            <span className="block text-body-small-default text-[var(--content-tertiary)]">
              Root domain used for assistant email addresses (e.g. vellum.me).
            </span>
          </div>
        </div>
      </div>
    </DetailCard>
  );
}
