import { useCallback, type ReactNode } from "react";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import {
  isProviderSelectableForAssistant,
  parseEntryPickerValue,
} from "@/domains/settings/ai/provider-availability";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";

/**
 * Right-aligned muted annotation on a provider-picker row: the row answers
 * "whose infrastructure" at the moment of choice (Managed / Custom).
 */
export function PickerMeta({ text }: { text: string }) {
  return (
    <span className="text-body-small-default text-[var(--content-tertiary)]">
      {text}
    </span>
  );
}

/**
 * `Select` option fields describing whether the active assistant can use a
 * provider. Empty for a usable one; a provider it cannot reach keeps its row
 * and carries the reason instead.
 */
export interface ProviderPickerAvailability {
  readonly disabled?: boolean;
  readonly tooltip?: string;
  readonly suffix?: ReactNode;
}

/**
 * Availability fields for one provider row, keyed by its picker value (a
 * provider id or an entry value). Spread into the option after the surface's
 * own `suffix` so the reason replaces an annotation the assistant cannot act
 * on ("Add API key" for a provider it cannot reach).
 *
 * The reason is both a visible annotation and a hover tooltip: a disabled
 * Radix option takes no focus, so tooltip-only copy never reaches a keyboard
 * or touch user.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/select#item
 */
export function useProviderPickerAvailability(): (
  pickerValue: string,
) => ProviderPickerAvailability {
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();
  const { t } = useTranslation("settings");
  return useCallback(
    (pickerValue: string) => {
      const provider =
        parseEntryPickerValue(pickerValue)?.provider ?? pickerValue;
      if (
        isProviderSelectableForAssistant(provider, activeAssistantIsSelfHosted)
      ) {
        return {};
      }
      return {
        disabled: true,
        suffix: <PickerMeta text={t("aiProviderPicker.selfHostedOnlyMeta")} />,
        tooltip: t("aiProviderPicker.selfHostedOnlyTooltip", {
          name: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
        }),
      };
    },
    [activeAssistantIsSelfHosted, t],
  );
}
