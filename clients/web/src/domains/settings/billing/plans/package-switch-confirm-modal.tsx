import { AlertTriangle } from "lucide-react";

import type { TierRelation } from "@/domains/settings/billing/package-types";
import { downgradeLabel } from "@/domains/settings/billing/plans/plans-copy";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

export interface PackageSwitchConfirmModalProps {
  open: boolean;
  /** How the target relates to the current tier — drives copy and chrome. */
  relation: Exclude<TierRelation, "current">;
  /** Target package display name, e.g. "Mighty". */
  packageName: string;
  /** A change-package call is in flight — disable the actions. */
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// Package switches apply immediately (no period-end deferral): an upgrade
// charges the prorated difference now; a downgrade resizes the machine now and
// nets a prorated credit against the next invoice — storage stays, no cash
// refund. The copy must not imply the higher tier is kept until month end.
const DOWNGRADE_NOTE =
  "Your machine downsizes now and your storage stays. No refund — a prorated credit applies to your next invoice.";
const UPGRADE_NOTE = "You'll be charged the prorated difference now.";

/**
 * Reconfirm dialog for a one-click Pro package switch from the plans takeover.
 * A downgrade gets the AlertTriangle + danger confirm; an upgrade gets a
 * lighter primary confirm. Layout-only — the parent owns the mutation.
 */
export function PackageSwitchConfirmModal({
  open,
  relation,
  packageName,
  pending,
  onCancel,
  onConfirm,
}: PackageSwitchConfirmModalProps) {
  const isDowngrade = relation === "downgrade";
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
          <Modal.Title icon={isDowngrade ? AlertTriangle : undefined}>
            {isDowngrade
              ? `Downgrade to ${packageName}?`
              : `Upgrade to ${packageName}?`}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-(--content-secondary)"
          >
            {isDowngrade ? DOWNGRADE_NOTE : UPGRADE_NOTE}
          </Typography>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={isDowngrade ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending}
            data-testid="confirm-package-switch-button"
          >
            {isDowngrade ? downgradeLabel(packageName) : `Switch to ${packageName}`}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
