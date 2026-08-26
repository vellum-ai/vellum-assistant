import { Select } from "@vellumai/design-library/components/select";

import { DetailCard } from "@/components/detail-card";
import type { ContactPayload } from "@/domains/contacts/types";
import { useTranslation } from "@/i18n";
import {
  THRESHOLD_PRESETS,
  type RiskThreshold,
} from "@/utils/threshold-presets";

export interface ContactAutoApproveThresholdSectionProps {
  contact: ContactPayload;
  pending: boolean;
  onChange: (threshold: RiskThreshold | null) => void;
}

const PRESET_LABEL_KEY = {
  none: "contactAutoApproveThreshold.preset.none",
  low: "contactAutoApproveThreshold.preset.low",
  medium: "contactAutoApproveThreshold.preset.medium",
  high: "contactAutoApproveThreshold.preset.high",
} as const;

const PRESET_DESCRIPTION_KEY = {
  none: "contactAutoApproveThreshold.description.none",
  low: "contactAutoApproveThreshold.description.low",
  medium: "contactAutoApproveThreshold.description.medium",
  high: "contactAutoApproveThreshold.description.high",
} as const;

function isRiskThreshold(value: string | null | undefined): value is RiskThreshold {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

export function ContactAutoApproveThresholdSection({
  contact,
  pending,
  onChange,
}: ContactAutoApproveThresholdSectionProps) {
  const { t } = useTranslation("contacts");
  const selected = isRiskThreshold(contact.autoApproveThreshold)
    ? contact.autoApproveThreshold
    : null;

  const options = [
    {
      value: null,
      label: t("contactAutoApproveThreshold.inheritLabel"),
    },
    ...THRESHOLD_PRESETS.map((preset) => ({
      value: preset.riskThreshold,
      label: t(PRESET_LABEL_KEY[preset.riskThreshold]),
      icon: <preset.icon className="h-3.5 w-3.5" />,
    })),
  ];

  const description =
    selected === null
      ? t("contactAutoApproveThreshold.inheritDescription")
      : t(PRESET_DESCRIPTION_KEY[selected]);

  return (
    <DetailCard
      title={t("contactAutoApproveThreshold.title")}
      subtitle={t("contactAutoApproveThreshold.subtitle")}
    >
      <div className="flex flex-col gap-2">
        <div style={{ maxWidth: 280 }}>
          <Select
            value={selected}
            onChange={onChange}
            onSelectNone={() => onChange(null)}
            options={options}
            disabled={pending}
            aria-label={t("contactAutoApproveThreshold.title")}
            data-testid="contact-auto-approve-threshold"
          />
        </div>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {description}
        </p>
      </div>
    </DetailCard>
  );
}
