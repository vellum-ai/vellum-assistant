import { Select } from "@vellumai/design-library/components/select";

import { DetailCard } from "@/components/detail-card";
import type { ContactPayload } from "@/domains/contacts/types";
import { useTranslation } from "@/i18n";
import {
  THRESHOLD_PRESETS,
  type ThresholdPreset,
} from "@/utils/threshold-presets";

type StoredThreshold = NonNullable<ContactPayload["autoApproveThreshold"]>;
type PresetId = ThresholdPreset["id"];

function isStoredThreshold(value: unknown): value is StoredThreshold {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

function presetLabel(
  t: ReturnType<typeof useTranslation<"contacts">>["t"],
  threshold: StoredThreshold,
): string {
  switch (threshold) {
    case "none":
      return t("contactPermissions.preset.none");
    case "low":
      return t("contactPermissions.preset.low");
    case "medium":
      return t("contactPermissions.preset.medium");
    case "high":
      return t("contactPermissions.preset.high");
  }
}

function thresholdDescription(
  t: ReturnType<typeof useTranslation<"contacts">>["t"],
  threshold: StoredThreshold | null,
): string {
  if (threshold === null) {
    return t("contactPermissions.inheritDescription");
  }
  switch (threshold) {
    case "none":
      return t("contactPermissions.description.none");
    case "low":
      return t("contactPermissions.description.low");
    case "medium":
      return t("contactPermissions.description.medium");
    case "high":
      return t("contactPermissions.description.high");
  }
}

export function canEditContactPermissions(
  contact: Pick<ContactPayload, "role" | "contactType">,
): boolean {
  return contact.role !== "guardian" && contact.contactType !== "assistant";
}

export function ContactPermissionsSection({
  contact,
  pending,
  onAutoApproveThresholdChange,
}: {
  contact: ContactPayload;
  pending?: boolean;
  onAutoApproveThresholdChange: (
    autoApproveThreshold: ContactPayload["autoApproveThreshold"],
  ) => void;
}) {
  const { t } = useTranslation("contacts");
  const storedThreshold = isStoredThreshold(contact.autoApproveThreshold)
    ? contact.autoApproveThreshold
    : null;
  const selectedPreset =
    storedThreshold === null
      ? null
      : THRESHOLD_PRESETS.find(
          (preset) => preset.riskThreshold === storedThreshold,
        );

  return (
    <DetailCard
      title={t("contactPermissions.title")}
      subtitle={t("contactPermissions.subtitle")}
    >
      <div className="flex flex-col gap-2" data-testid="contact-permissions">
        <div style={{ maxWidth: 280 }}>
          <Select<PresetId>
            value={selectedPreset?.id ?? null}
            placeholder={t("contactPermissions.inheritLabel")}
            disabled={pending}
            onSelectNone={() => {
              onAutoApproveThresholdChange(null);
            }}
            onChange={(presetId) => {
              const preset = THRESHOLD_PRESETS.find((p) => p.id === presetId);
              if (!preset) {
                return;
              }
              onAutoApproveThresholdChange(preset.riskThreshold);
            }}
            options={[
              {
                value: null,
                label: t("contactPermissions.inheritLabel"),
              },
              ...THRESHOLD_PRESETS.map((preset) => {
                const Icon = preset.icon;
                return {
                  value: preset.id,
                  label: presetLabel(t, preset.riskThreshold),
                  icon: <Icon className="h-3.5 w-3.5" />,
                };
              }),
            ]}
          />
        </div>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {thresholdDescription(t, storedThreshold)}
        </p>
      </div>
    </DetailCard>
  );
}
