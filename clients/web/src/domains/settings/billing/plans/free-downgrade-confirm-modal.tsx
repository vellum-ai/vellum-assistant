import { AlertTriangle } from "lucide-react";

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
  /** A billing-portal session is being created — disable the actions. */
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Reconfirm dialog for cancelling Pro ("Downgrade to Free") from the plans
 * takeover. Mirrors the adjust-plan modal's "Downgrade to Base?" step: it lists
 * the Pro features that will be lost before handing off to the Stripe billing
 * portal, where the actual cancellation happens. Layout-only — the parent owns
 * the portal mutation.
 */
export function FreeDowngradeConfirmModal({
  open,
  lostFeatures,
  pending,
  onCancel,
  onConfirm,
}: FreeDowngradeConfirmModalProps) {
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
        <Modal.Header>
          <Modal.Title icon={AlertTriangle}>Downgrade to Free?</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-(--content-secondary)"
          >
            {hasLostFeatures
              ? "Downgrading removes the following Pro features. You'll be taken to Stripe to cancel your subscription."
              : "You'll be taken to Stripe to cancel your subscription."}
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
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={pending}
            data-testid="confirm-free-downgrade-button"
          >
            Downgrade to Free
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
