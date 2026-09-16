import { AlertTriangle } from "lucide-react";
import { useState } from "react";

import {
  CancelReasonSurvey,
  type CancelReasonSurveyValue,
  EMPTY_CANCEL_REASON,
  isCancelReasonComplete,
} from "@/domains/settings/billing/cancel-reason-survey";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

export interface FreeDowngradeConfirmModalProps {
  open: boolean;
  /**
   * Pro features lost by downgrading to Free (the Pro plan's `included_features`
   * minus the Free plan's). Empty when the catalog lists none — the list is then
   * omitted and the dialog shows just the cancellation note.
   */
  lostFeatures: string[];
  /**
   * Confirming hands off to the Stripe billing portal instead of cancelling
   * in-app (a Pro sub the cancel endpoint rejects); the body copy says so.
   */
  viaPortal: boolean;
  /** The cancellation request is in flight; the actions are disabled. */
  pending: boolean;
  onCancel: () => void;
  /**
   * The cancel survey the user filled in. Empty (no reason) on the portal
   * handoff, where Stripe's own cancel page asks instead.
   */
  onConfirm: (survey: CancelReasonSurveyValue) => void;
}

/**
 * Reconfirm dialog for cancelling Pro ("Downgrade to Base") from the plans
 * takeover. Mirrors the adjust-plan modal's step of the same name: it lists
 * the Pro features that will be lost and asks why before the cancellation is
 * scheduled via the subscription-cancel endpoint. The parent owns the cancel
 * mutation; the survey form state lives in the dialog content, which Radix
 * unmounts on close, so a reopened confirm starts blank.
 */
export function FreeDowngradeConfirmModal({
  open,
  pending,
  onCancel,
  ...contentProps
}: FreeDowngradeConfirmModalProps) {
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          onCancel();
        }
      }}
    >
      <Modal.Content size="md" hideCloseButton>
        <FreeDowngradeConfirmContent
          pending={pending}
          onCancel={onCancel}
          {...contentProps}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

function FreeDowngradeConfirmContent({
  lostFeatures,
  viaPortal,
  pending,
  onCancel,
  onConfirm,
}: Omit<FreeDowngradeConfirmModalProps, "open">) {
  const { t } = useTranslation("settings");
  const hasLostFeatures = lostFeatures.length > 0;
  const [survey, setSurvey] = useState(EMPTY_CANCEL_REASON);
  // The in-app cancel needs a reason; the portal collects its own.
  const canConfirm = viaPortal || isCancelReasonComplete(survey);
  return (
    <>
    <Modal.Header icon={AlertTriangle}>
      <Modal.Title>{t("freeDowngradeConfirmModal.title")}</Modal.Title>
    </Modal.Header>
    <Modal.Body>
      <Typography
        as="p"
        variant="body-medium-default"
        className="text-(--content-secondary)"
      >
        {viaPortal
          ? hasLostFeatures
            ? t("freeDowngradeConfirmModal.bodyWithFeaturesPortal")
            : t("freeDowngradeConfirmModal.bodyCancelOnlyPortal")
          : hasLostFeatures
            ? t("freeDowngradeConfirmModal.bodyWithFeatures")
            : t("freeDowngradeConfirmModal.bodyCancelOnly")}
      </Typography>
      {hasLostFeatures ? (
        <ul className="mt-4 list-disc space-y-2 pl-5">
          {lostFeatures.map((feature) => (
            <li key={feature}>
              <Typography as="span" variant="body-medium-default">
                {feature}
              </Typography>
            </li>
          ))}
        </ul>
      ) : null}
      {viaPortal ? null : (
        <CancelReasonSurvey
          value={survey}
          onChange={setSurvey}
          disabled={pending}
        />
      )}
    </Modal.Body>
    <Modal.Footer>
      <Button variant="outlined" onClick={onCancel} disabled={pending}>
        {t("freeDowngradeConfirmModal.cancel")}
      </Button>
      <Button
        variant="danger"
        onClick={() => onConfirm(survey)}
        disabled={pending || !canConfirm}
        data-testid="confirm-free-downgrade-button"
      >
        {t("freeDowngradeConfirmModal.confirm")}
      </Button>
    </Modal.Footer>
    </>
  );
}
