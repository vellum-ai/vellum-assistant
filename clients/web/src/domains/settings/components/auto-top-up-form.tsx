import { useState, type ChangeEvent } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

export interface AutoTopUpFormValues {
  threshold_usd: string;
  amount_usd: string;
  monthly_cap_usd: string;
}

export interface AutoTopUpFormProps {
  initialValues?: AutoTopUpFormValues;
  submitting: boolean;
  serverErrors: Record<string, string>;
  onSave: (values: AutoTopUpFormValues) => void;
  onCancel: () => void;
}

export type AutoTopUpFormErrors = Partial<Record<keyof AutoTopUpFormValues, string>>;

const DEFAULTS: AutoTopUpFormValues = {
  threshold_usd: "100",
  amount_usd: "10",
  monthly_cap_usd: "",
};

/**
 * Drop the decimal portion of a USD form-field string. Used by `onBlur` and
 * `handleSubmit` to coerce transient decimal/exponent typing (e.g. "12.5",
 * "1e2") to its truncated integer string ("12", "100"). Empty string and
 * lone "-" pass through unchanged so typing-in-progress states aren't lost.
 */
function coerceUsdToIntStr(v: string): string {
  if (v === "" || v === "-") return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : "";
}

/**
 * Validate the auto top-up form values against the same bounds the DRF
 * serializer enforces server-side. Exported so unit tests can exercise the
 * locked validators without rendering the form.
 *
 * Bounds (locked in plan, mirrored on server):
 * - amount_usd: $10..$500
 * - threshold_usd: $1..$100
 * - monthly_cap_usd: optional. If provided, $25..$10000, must be >= amount.
 *   Empty string = uncapped (sent to API as null).
 *
 * The form accepts integer-only USD strings; the input `onBlur` handler
 * truncates any decimals the user types when focus leaves the field, and
 * `handleSubmit` does the same coercion just-in-time at submit.
 * Transient decimal strings (e.g. "12.5" mid-typing) still validate
 * correctly here because `parseFloat` accepts them. `handleSubmit`
 * formats the integer back to "X.00" only at the API boundary, since
 * the DRF serializer still requires two decimal places.
 */
export function validateAutoTopUpValues(
  values: AutoTopUpFormValues,
): AutoTopUpFormErrors {
  const errors: AutoTopUpFormErrors = {};

  const threshold = parseFloat(values.threshold_usd);
  const amount = parseFloat(values.amount_usd);

  if (!Number.isFinite(amount) || amount < 10 || amount > 500) {
    errors.amount_usd = "Must be between $10 and $500";
  }
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
    errors.threshold_usd = "Must be between $1 and $100";
  }
  // `monthly_cap_usd` is optional: an empty string means "no cap / uncapped"
  // and is sent to the API as `null` (the backend serializer accepts null
  // for the uncapped scenario). Skip both the range check and the
  // cross-field cap-vs-amount check entirely when the field is empty.
  if (values.monthly_cap_usd !== "") {
    const cap = parseFloat(values.monthly_cap_usd);
    if (!Number.isFinite(cap) || cap < 25 || cap > 10000) {
      errors.monthly_cap_usd = "Must be between $25 and $10,000";
    } else if (Number.isFinite(amount) && cap < amount) {
      errors.monthly_cap_usd = "Must be at least the top-up amount";
    }
  }
  return errors;
}

/**
 * Resolve the visible error for a field, given client + server errors and
 * whether the field is touched / submission has been attempted. Server
 * errors win over client errors on the same field. Client errors only
 * surface after blur or after a Save attempt.
 */
export function visibleAutoTopUpError(
  field: keyof AutoTopUpFormValues,
  clientErrors: AutoTopUpFormErrors,
  serverErrors: Record<string, string>,
  touched: boolean,
): string | undefined {
  if (serverErrors[field]) return serverErrors[field];
  if (touched) return clientErrors[field];
  return undefined;
}

export function AutoTopUpForm({
  initialValues = DEFAULTS,
  submitting,
  serverErrors,
  onSave,
  onCancel,
}: AutoTopUpFormProps) {
  const [values, setValues] = useState<AutoTopUpFormValues>(initialValues);
  const [touched, setTouched] = useState<Record<keyof AutoTopUpFormValues, boolean>>({
    threshold_usd: false,
    amount_usd: false,
    monthly_cap_usd: false,
  });

  const clientErrors = validateAutoTopUpValues(values);

  const onChange =
    (field: keyof AutoTopUpFormValues) =>
    (e: ChangeEvent<HTMLInputElement>) => {
      // Preserve the raw input verbatim during typing — coercing per-keystroke
      // (e.g. parseFloat + Math.trunc) drops the decimal point as soon as it's
      // typed and turns "12.5" into "125". Decimal-stripping happens at blur
      // and at submit (handleSubmit) instead.
      setValues((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const onBlur = (field: keyof AutoTopUpFormValues) => () => {
    setTouched((prev) => ({ ...prev, [field]: true }));
    setValues((prev) => ({ ...prev, [field]: coerceUsdToIntStr(prev[field]) }));
  };

  const visibleError = (field: keyof AutoTopUpFormValues): string | undefined =>
    visibleAutoTopUpError(field, clientErrors, serverErrors, touched[field]);

  const handleSubmit = () => {
    setTouched({ threshold_usd: true, amount_usd: true, monthly_cap_usd: true });
    // Validate against the COERCED submit values, not the focused-typing
    // snapshot. Otherwise an in-progress decimal like "12.9" can fail
    // hysteresis (12.9 >= 12.5) even though its truncated submit value
    // (12 < 12.5) is valid — forcing the user to click Save twice.
    const coercedValues: AutoTopUpFormValues = {
      threshold_usd: coerceUsdToIntStr(values.threshold_usd),
      amount_usd: coerceUsdToIntStr(values.amount_usd),
      monthly_cap_usd: coerceUsdToIntStr(values.monthly_cap_usd),
    };
    setValues(coercedValues);
    const submitErrors = validateAutoTopUpValues(coercedValues);
    const allValid = Object.keys(submitErrors).length === 0;
    if (!allValid) return;
    const toApiFormat = (v: string): string =>
      v === "" ? "" : `${parseInt(v, 10)}.00`;
    onSave({
      threshold_usd: toApiFormat(coercedValues.threshold_usd),
      amount_usd: toApiFormat(coercedValues.amount_usd),
      monthly_cap_usd:
        coercedValues.monthly_cap_usd === ""
          ? ""
          : toApiFormat(coercedValues.monthly_cap_usd),
    });
  };

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[10rem] flex-1">
          <Input
            type="number"
            step="1"
            label="Auto-Reload when balance below"
            value={values.threshold_usd}
            onChange={onChange("threshold_usd")}
            onBlur={onBlur("threshold_usd")}
            errorText={visibleError("threshold_usd")}
            data-testid="auto-top-up-threshold-input"
            fullWidth
          />
        </div>
        <div className="min-w-[10rem] flex-1">
          <Input
            type="number"
            step="1"
            label="Add amount when auto reloading"
            value={values.amount_usd}
            onChange={onChange("amount_usd")}
            onBlur={onBlur("amount_usd")}
            errorText={visibleError("amount_usd")}
            data-testid="auto-top-up-amount-input"
            fullWidth
          />
        </div>
        <div className="min-w-[10rem] flex-1">
          <Input
            type="number"
            step="1"
            label="Monthly spending cap"
            helperText="Pauses auto top-ups for the rest of the month once spending reaches this amount. Manual purchases also count toward the total. Leave empty for no limit."
            value={values.monthly_cap_usd}
            onChange={onChange("monthly_cap_usd")}
            onBlur={onBlur("monthly_cap_usd")}
            errorText={visibleError("monthly_cap_usd")}
            data-testid="auto-top-up-cap-input"
            fullWidth
          />
        </div>
        {/*
         * `pt-[18px]` aligns buttons with the input box: label is 12px
         * tall + 6px gap-1.5 in the Input wrapper = 18px before the input
         * starts. Switching the row to `items-start` (so error messages
         * hang below without lifting other columns) means buttons would
         * otherwise render at the very top of the row next to the labels.
         */}
        <div className="flex shrink-0 items-center gap-2 pt-[18px]">
          <Button variant="outlined" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="auto-top-up-save-button"
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
