import type {
  CancellationFeedbackEnum,
  SubscriptionCancelRequestRequest,
} from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";
import { Textarea } from "@vellumai/design-library/components/input";
import { Radio, RadioGroup } from "@vellumai/design-library/components/radio";
import { Typography } from "@vellumai/design-library/components/typography";

/**
 * Stripe's fixed `cancellation_details.feedback` vocabulary, in the order the
 * survey lists it: the common reasons first, "Other" last.
 */
export const CANCEL_REASON_OPTIONS = [
  "too_expensive",
  "missing_features",
  "switched_service",
  "unused",
  "too_complex",
  "low_quality",
  "customer_service",
  "other",
] as const satisfies readonly CancellationFeedbackEnum[];

const OPTION_LABEL_KEYS = {
  too_expensive: "cancelReasonSurvey.optionTooExpensive",
  missing_features: "cancelReasonSurvey.optionMissingFeatures",
  switched_service: "cancelReasonSurvey.optionSwitchedService",
  unused: "cancelReasonSurvey.optionUnused",
  too_complex: "cancelReasonSurvey.optionTooComplex",
  low_quality: "cancelReasonSurvey.optionLowQuality",
  customer_service: "cancelReasonSurvey.optionCustomerService",
  other: "cancelReasonSurvey.optionOther",
} as const satisfies Record<CancellationFeedbackEnum, string>;

/** Mirrors the platform serializer's `CANCELLATION_COMMENT_MAX_LENGTH`. */
export const CANCEL_COMMENT_MAX_LENGTH = 1000;

export interface CancelReasonSurveyValue {
  feedback: CancellationFeedbackEnum | null;
  comment: string;
}

export const EMPTY_CANCEL_REASON: CancelReasonSurveyValue = {
  feedback: null,
  comment: "",
};

/** A reason must be picked before the cancellation can be confirmed. */
export function isCancelReasonComplete(value: CancelReasonSurveyValue): boolean {
  return value.feedback != null;
}

/**
 * The cancel endpoint's request body. The free-text comment only travels with
 * "Other": the textarea is hidden for every other reason, so text typed before
 * switching away is not something the user chose to send.
 */
export function toCancelRequestBody(
  value: CancelReasonSurveyValue,
): SubscriptionCancelRequestRequest {
  const comment = value.feedback === "other" ? value.comment.trim() : "";
  return { feedback: value.feedback, comment: comment || null };
}

export interface CancelReasonSurveyProps {
  value: CancelReasonSurveyValue;
  onChange: (next: CancelReasonSurveyValue) => void;
  disabled?: boolean;
}

/**
 * The "why are you canceling?" step shared by both Pro cancellation confirms
 * (the adjust-plan modal and the plans takeover). Single-select over Stripe's
 * feedback vocabulary, with a free-text box that appears for "Other". The
 * parent owns the value and forwards it to the cancel endpoint, which writes
 * it to Stripe as `cancellation_details` for the admin revenue dashboard.
 */
export function CancelReasonSurvey({
  value,
  onChange,
  disabled,
}: CancelReasonSurveyProps) {
  const { t } = useTranslation("settings");
  return (
    <div className="mt-5 space-y-3" data-testid="cancel-reason-survey">
      <Typography as="p" variant="body-medium-default">
        {t("cancelReasonSurvey.title")}
      </Typography>
      <RadioGroup<CancellationFeedbackEnum | "">
        value={value.feedback ?? ""}
        onValueChange={(next) =>
          onChange({ ...value, feedback: next === "" ? null : next })
        }
        name="cancel-reason"
        disabled={disabled}
        aria-label={t("cancelReasonSurvey.title")}
      >
        {CANCEL_REASON_OPTIONS.map((option) => (
          <Radio key={option} value={option} label={t(OPTION_LABEL_KEYS[option])} />
        ))}
      </RadioGroup>
      {value.feedback === "other" ? (
        <Textarea
          label={t("cancelReasonSurvey.otherLabel")}
          placeholder={t("cancelReasonSurvey.otherPlaceholder")}
          value={value.comment}
          onChange={(event) =>
            onChange({ ...value, comment: event.target.value })
          }
          maxLength={CANCEL_COMMENT_MAX_LENGTH}
          rows={3}
          disabled={disabled}
          fullWidth
          data-testid="cancel-reason-comment"
        />
      ) : null}
    </div>
  );
}
