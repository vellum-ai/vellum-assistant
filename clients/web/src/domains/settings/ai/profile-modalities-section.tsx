import { ChevronRight } from "lucide-react";

import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  INPUT_MODALITIES,
  catalogSupportedForFreeText,
  modalityEnabled,
  modalitySupported,
  type InputModalities,
  type InputModality,
  type ModalityOverride,
} from "@/domains/settings/ai/profile-modalities";
import { useTranslation } from "@/i18n";

export interface ProfileModalitiesSectionProps {
  value: InputModalities;
  onChange: (next: InputModalities) => void;
  isReadOnly: boolean;
  /** Panel layout keeps the table visible; modal layout starts collapsed. */
  expanded: boolean;
  onExpandedChange?: (open: boolean) => void;
  collapsible: boolean;
}

const MODALITY_LABEL_KEYS = {
  image: "profileModalitiesSection.image",
  audio: "profileModalitiesSection.audio",
} as const;

function setOverride(
  current: InputModalities,
  modality: InputModality,
  override: ModalityOverride | undefined,
): InputModalities {
  const next = { ...current };
  if (override == null) {
    delete next[modality];
  } else {
    next[modality] = override;
  }
  return next;
}

export function ProfileModalitiesSection({
  value,
  onChange,
  isReadOnly,
  expanded,
  onExpandedChange,
  collapsible,
}: ProfileModalitiesSectionProps) {
  const { t } = useTranslation("settings");

  const table = (
    <div className="space-y-3">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
      >
        {t("profileModalitiesSection.helper")}
      </Typography>
      <table className="w-full border-collapse text-body-small-default">
        <thead>
          <tr className="text-left text-[var(--content-tertiary)]">
            <th className="pb-2 pr-3 font-medium" scope="col">
              <span className="sr-only">
                {t("profileModalitiesSection.title")}
              </span>
            </th>
            <th className="pb-2 pr-3 font-medium" scope="col">
              {t("profileModalitiesSection.enabledColumn")}
            </th>
            <th className="pb-2 font-medium" scope="col">
              {t("profileModalitiesSection.supportedColumn")}
            </th>
          </tr>
        </thead>
        <tbody>
          {INPUT_MODALITIES.map((modality) => {
            const enabled = modalityEnabled(modality, value[modality]);
            const supported = modalitySupported(
              modality,
              value[modality],
              enabled,
            );
            const catalog = catalogSupportedForFreeText(modality);
            const reachesWire = enabled && supported;
            const label = t(MODALITY_LABEL_KEYS[modality]);
            return (
              <tr key={modality}>
                <th
                  className="py-2 pr-3 font-medium text-[var(--content-primary)]"
                  scope="row"
                >
                  <div>{label}</div>
                  <div className="text-[var(--content-tertiary)] font-normal">
                    {reachesWire
                      ? t("profileModalitiesSection.resolvedOn")
                      : t("profileModalitiesSection.resolvedOff")}
                  </div>
                </th>
                <td className="py-2 pr-3">
                  <Toggle
                    size="sm"
                    checked={enabled}
                    disabled={isReadOnly}
                    aria-label={t("profileModalitiesSection.enableAria", {
                      modality: label,
                    })}
                    onChange={(nextEnabled) => {
                      if (!nextEnabled) {
                        onChange(setOverride(value, modality, undefined));
                        return;
                      }
                      onChange(
                        setOverride(value, modality, {
                          enabled: true,
                          supported: catalog,
                        }),
                      );
                    }}
                  />
                </td>
                <td className="py-2">
                  <Toggle
                    size="sm"
                    checked={supported}
                    disabled={isReadOnly || !enabled}
                    aria-label={t("profileModalitiesSection.supportedAria", {
                      modality: label,
                    })}
                    onChange={(nextSupported) => {
                      onChange(
                        setOverride(value, modality, {
                          enabled: true,
                          supported: nextSupported,
                        }),
                      );
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (!collapsible) {
    return <div className="space-y-2">{table}</div>;
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange?.(!expanded)}
        className="flex items-center gap-1 text-body-small-default text-[var(--content-secondary)] w-full text-left"
      >
        <ChevronRight
          className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span>{t("profileModalitiesSection.title")}</span>
      </button>
      {expanded ? <div className="mt-4">{table}</div> : null}
    </div>
  );
}
