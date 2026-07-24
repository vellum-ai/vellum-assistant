import { AlertTriangle } from "lucide-react";

import type { SwitchRelation } from "@/domains/settings/billing/package-types";
import { downgradeLabel } from "@/domains/settings/billing/plans/plans-copy";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

export interface PackageSwitchConfirmModalProps {
  open: boolean;
  /**
   * How the target relates to the current tier — drives copy and chrome.
   * "switch" is the direction-neutral variant for a Custom sub, whose catalog
   * rank is unknown, so up-vs-down cannot be labelled.
   */
  relation: SwitchRelation;
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
// A Custom sub's direction is unknown, so the copy stays neutral: the change is
// immediate and the prorated difference settles either way.
const SWITCH_NOTE =
  "Your plan changes now. Any prorated difference is charged now or credited to your next invoice.";

/**
 * Reconfirm dialog for a one-click Pro package switch from the plans takeover.
 * A downgrade gets the AlertTriangle + danger confirm; an upgrade and a
 * direction-neutral switch get a lighter primary confirm. Layout-only — the
 * parent owns the mutation.
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
  const isSwitch = relation === "switch";
  const title = isDowngrade
    ? `Downgrade to ${packageName}?`
    : isSwitch
      ? `Switch to ${packageName}?`
      : `Upgrade to ${packageName}?`;
  const note = isDowngrade
    ? DOWNGRADE_NOTE
    : isSwitch
      ? SWITCH_NOTE
      : UPGRADE_NOTE;
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
            {title}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-(--content-secondary)"
          >
            {note}
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
            {isDowngrade
              ? downgradeLabel(packageName)
              : `Switch to ${packageName}`}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
