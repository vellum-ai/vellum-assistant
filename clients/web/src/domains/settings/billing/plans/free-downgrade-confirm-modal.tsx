import { AlertTriangle } from "lucide-react";

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
  onConfirm: () => void;
}

/**
 * Reconfirm dialog for cancelling Pro ("Downgrade to Base") from the plans
 * takeover. Mirrors the adjust-plan modal's step of the same name: it lists
 * the Pro features that will be lost before the cancellation is scheduled via
 * the subscription-cancel endpoint. Layout-only; the parent owns the cancel
 * mutation.
 */
export function FreeDowngradeConfirmModal({
  open,
  lostFeatures,
  viaPortal,
  pending,
  onCancel,
  onConfirm,
}: FreeDowngradeConfirmModalProps) {
  const { t } = useTranslation("settings");
  const hasLostFeatures = lostFeatures.length > 0;
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
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onCancel} disabled={pending}>
            {t("freeDowngradeConfirmModal.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={pending}
            data-testid="confirm-free-downgrade-button"
          >
            {t("freeDowngradeConfirmModal.confirm")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
