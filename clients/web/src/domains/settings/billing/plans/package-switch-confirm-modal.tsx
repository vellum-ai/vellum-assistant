import { CircleCheck } from "lucide-react";

import { AssistantAvatarTile } from "@/domains/settings/billing/assistant-avatar-tile";
import type {
  ProPackage,
  SwitchRelation,
} from "@/domains/settings/billing/package-types";
import { packageHighlights } from "@/domains/settings/billing/plan-spec";
import { packageSwitchCopy } from "@/domains/settings/billing/plans/package-switch-copy";
import { getPlanTierCopy } from "@/domains/settings/billing/plans/plans-copy";
import { formatMonthly } from "@/domains/settings/components/tier-pricing";
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
  /**
   * Target package from the live catalog — drives the price line and the
   * checklist. Null while the takeover has not resolved a target; the modal
   * then renders header + actions only.
   */
  targetPackage: ProPackage | null;
  /** A change-package call is in flight — disable the actions. */
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Reconfirm dialog for a one-click Pro package switch. A downgrade gets the
 * danger confirm plus its safeguard note; an upgrade and a direction-neutral
 * switch get a lighter primary confirm. Layout-only for the mutation — the
 * parent owns `change-package` — but it does read the assistant avatar through
 * `AssistantAvatarTile`, so both call sites get the header glyph without
 * duplicating that wiring.
 */
export function PackageSwitchConfirmModal({
  open,
  relation,
  packageName,
  targetPackage,
  pending,
  onCancel,
  onConfirm,
}: PackageSwitchConfirmModalProps) {
  const copy = packageSwitchCopy(
    relation,
    packageName,
    targetPackage?.key ?? null,
  );
  // Everything below the header describes one concrete package, so it all
  // resolves — or doesn't — together.
  const details = targetPackage
    ? {
        price: formatMonthly(targetPackage.total_price_cents),
        highlights: packageHighlights(
          targetPackage,
          getPlanTierCopy(targetPackage.key)?.extraFeatures ?? [],
        ),
      }
    : null;

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          onCancel();
        }
      }}
    >
      <Modal.Content size="sm" hideCloseButton className="gap-6 p-4">
        <Modal.Header className="flex-row items-center gap-3 p-0">
          <AssistantAvatarTile />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Modal.Title className="text-title-small text-[var(--content-emphasised)]">
              {copy.title}
            </Modal.Title>
            {copy.subtitle ? (
              <Modal.Description className="mt-0 text-body-medium-default text-[var(--content-tertiary)]">
                {copy.subtitle}
              </Modal.Description>
            ) : null}
          </div>
        </Modal.Header>
        {details ? (
          <Modal.Body className="flex flex-col gap-4 p-0">
            <div className="flex flex-col gap-1">
              <Typography
                as="p"
                variant="title-large"
                className="text-[var(--content-default)]"
              >
                {details.price}
              </Typography>
              <Typography
                as="p"
                variant="label-medium-default"
                className="text-[var(--content-tertiary)]"
              >
                {copy.priceCaption}
              </Typography>
            </div>
            <div className="h-px w-full bg-[var(--border-hover)]" />
            <Typography
              as="p"
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
            >
              The plan includes
            </Typography>
            <ul className="flex flex-col gap-2">
              {details.highlights.map((row) => (
                <li key={row} className="flex items-center gap-1.5">
                  <CircleCheck
                    className="size-4 shrink-0 text-[var(--system-positive-strong)]"
                    aria-hidden
                  />
                  <Typography
                    as="span"
                    variant="body-medium-default"
                    className="text-[var(--content-default)]"
                  >
                    {row}
                  </Typography>
                </li>
              ))}
            </ul>
            {copy.note ? (
              <Typography
                as="p"
                variant="body-medium-default"
                className="text-[var(--content-secondary)]"
              >
                {copy.note}
              </Typography>
            ) : null}
          </Modal.Body>
        ) : null}
        <Modal.Footer className="flex-col gap-2 p-0">
          <Button
            fullWidth
            variant={copy.destructive ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending}
            data-testid="confirm-package-switch-button"
          >
            {copy.confirmLabel}
          </Button>
          <Button
            fullWidth
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
