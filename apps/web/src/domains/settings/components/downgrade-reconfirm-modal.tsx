import { AlertTriangle } from "lucide-react";

import { Button } from "@vellum/design-library/components/button";
import { Modal } from "@vellum/design-library/components/modal";
import { Typography } from "@vellum/design-library/components/typography";

/**
 * The Pro features released when an organization downgrades to Base.
 *
 * Surfaced verbatim in the reconfirm modal. The IDs are used only as stable
 * React keys for the rendered list items (the prior `ack_lost_features`
 * audit-trail payload was dropped when the downgrade endpoint was removed in
 * favor of the Stripe Customer Portal flow).
 */
export const LOST_FEATURES = [
  {
    id: "custom_domain",
    label:
      "Custom domain (email, web, API) — your assistant will use default Vellum domains",
  },
  {
    id: "static_ip",
    label: "Static IP address — your assistant's outbound IP will change",
  },
  {
    id: "priority_support",
    label: "Priority support",
  },
] as const;

export interface DowngradeReconfirmModalProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}

/**
 * Reconfirm dialog shown before a Pro → Base downgrade is committed.
 *
 * Why it composes `Modal.*` directly instead of using `ConfirmDialog`:
 * `ConfirmDialog`'s `message` prop is a single string rendered inside one
 * `<Typography>` block, which would collapse the structured bullet list of
 * features the user is losing. We're not bypassing the design system — we
 * use the same `Modal.Root` / `Content` / `Header` / `Body` / `Footer`
 * primitives that `ConfirmDialog` itself wraps.
 */
export function DowngradeReconfirmModal({
  open,
  onCancel,
  onConfirm,
  confirming,
}: DowngradeReconfirmModalProps) {
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        // Respect the in-flight `confirming` guard — Esc/backdrop must not
        // close the dialog while the downgrade mutation is mid-flight, even
        // though both buttons are disabled.
        if (!next && !confirming) {
          onCancel();
        }
      }}
    >
      <Modal.Content size="md" hideCloseButton>
        <Modal.Header>
          <Modal.Title icon={AlertTriangle}>Downgrade to Base?</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-(--content-secondary)"
          >
            Downgrading removes the following Pro features.
          </Typography>
          <ul className="mt-4 space-y-2 list-disc pl-5">
            {LOST_FEATURES.map((feature) => (
              <li key={feature.id}>
                <Typography as="span" variant="body-medium-default">
                  {feature.label}
                </Typography>
              </li>
            ))}
          </ul>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onCancel} disabled={confirming}>
            Keep Pro
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={confirming}
            data-testid="confirm-downgrade-button"
          >
            Confirm Downgrade
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
