import {
  Input,
  type InputProps,
} from "@vellumai/design-library/components/input";

import { t, useTranslation } from "@/i18n";
import { dailyResetTimePhrase } from "@/utils/daily-reset-time";

/**
 * Validate the daily-limit input against the bounds the backend enforces
 * (decimal ≥ $1, two decimal places). Exported so unit tests can exercise it
 * without rendering the field. An empty string is invalid here: turning the
 * limit off is done via the card's toggle (which clears it to `null`), not by
 * saving a blank amount.
 */
export function validateDailyLimit(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return t("settings:dailyCreditLimitCard.errorEmpty");
  }
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 1) {
    return t("settings:dailyCreditLimitCard.errorMin");
  }
  // Reject more than two decimal places (backend requires exactly two; we pad
  // on save, but can't silently round away cents the user typed).
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return t("settings:dailyCreditLimitCard.errorDecimals");
  }
  return undefined;
}

export type DailyCreditLimitInputProps = Omit<
  InputProps,
  "type" | "step" | "min" | "label" | "helperText" | "placeholder" | "fullWidth"
>;

/**
 * The daily credit limit amount field, shared by `DailyCreditLimitCard` and
 * the auto-reload daily-limit gate so both accept the same bounds and show
 * the same label and reset-time helper. Callers own the value, its
 * validation via `validateDailyLimit`, and the two-decimal PUT body.
 */
export function DailyCreditLimitInput(props: DailyCreditLimitInputProps) {
  const { t } = useTranslation("settings");
  return (
    <Input
      type="number"
      step="0.01"
      min="1"
      label={t("dailyCreditLimitCard.inputLabel")}
      helperText={t("dailyCreditLimitCard.helperText", {
        time: dailyResetTimePhrase(),
      })}
      placeholder="0.00"
      fullWidth
      {...props}
    />
  );
}
