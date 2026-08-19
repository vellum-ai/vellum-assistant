import { AlertTriangle, CircleCheck } from "lucide-react";
import { useId, useRef } from "react";

import { AssistantAvatarTile } from "@/domains/settings/billing/assistant-avatar-tile";
import { DialogHeaderTile } from "@/domains/settings/billing/dialog-header-tile";
import type {
  ProPackage,
  SwitchRelation,
} from "@/domains/settings/billing/package-types";
import { packageHighlights } from "@/domains/settings/billing/plan-spec";
import { packageSwitchCopy } from "@/domains/settings/billing/plans/package-switch-copy";
import { getPlanTierCopy } from "@/domains/settings/billing/plans/plans-copy";
import { formatMonthly } from "@/domains/settings/components/tier-pricing";
import { useTranslation } from "@/i18n";
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
 * warning glyph, loss-framed checklist copy, the danger confirm and its
 * safeguard note; an upgrade and a direction-neutral switch get the assistant
 * avatar and a lighter primary confirm. Layout-only for the mutation — the
 * parent owns `change-package`.
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
  const { t } = useTranslation("settings");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();
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
  // The header's second line, and only ever the tier's tagline. The package's
  // own catalog blurb is the checklist in sentence form ("Medium machine, 30 GB
  // of storage, and $45 in monthly credits."), and that checklist renders for
  // every package there is a blurb to read — so falling back to it would state
  // the same three facts twice, 40px apart. A relation that withholds the
  // tagline (a downgrade) simply gets a title-only header.
  const description = copy.subtitle;
  // Radix stamps `aria-describedby` at `Modal.Description`'s id whether or not
  // that element renders, so the dialog owns the attribute outright: a
  // destructive switch is described by its no-refund safeguard rather than by a
  // spec line, and a dialog with neither carries no attribute at all.
  const describedBy = copy.note
    ? { "aria-describedby": noteId }
    : description
      ? {}
      : { "aria-describedby": undefined };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          onCancel();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        // The mock's card is 421 wide — a 389px content column inside 16px of
        // padding — where `size="sm"` caps at 400. Overridden here rather than
        // in the shared Modal, which every other dialog sizes off.
        className="gap-4 p-4 max-w-[421px]"
        // The confirm sits above Cancel to match the mock, which puts it first
        // in the DOM too — and with no close button it is the first tabbable
        // node, so Radix's mount autofocus would arm Enter on an immediate,
        // unrefundable package change. Every relation opens on Cancel instead.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        {...describedBy}
      >
        {/* 8px here plus the 16px content gap makes the mock's 24px under the
            header, while that gap stays 16px between the checklist and the
            actions. */}
        <Modal.Header className="flex-row items-center gap-3 p-0 pb-2">
          {copy.destructive ? (
            <DialogHeaderTile
              data-testid="package-switch-warning-tile"
              className="bg-[var(--system-negative-weak)]"
            >
              <AlertTriangle className="size-6 text-[var(--system-negative-strong)]" />
            </DialogHeaderTile>
          ) : (
            <AssistantAvatarTile />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* A catalog or custom package name can outrun the 304px of title
                width a `size="sm"` card leaves, and the header column already
                allows a second line. */}
            <Modal.Title className="text-title-small text-[var(--content-emphasised)] [&>span]:whitespace-normal">
              {copy.title}
            </Modal.Title>
            {description ? (
              <Modal.Description className="mt-0 text-body-medium-default text-[var(--content-tertiary)]">
                {description}
              </Modal.Description>
            ) : null}
          </div>
        </Modal.Header>
        {details ? (
          <Modal.Body className="flex flex-col gap-4 p-0">
            <div className="flex flex-col gap-0.5">
              <Typography
                as="p"
                variant="title-large"
                className="text-[var(--content-default)]"
              >
                {details.price}
              </Typography>
              {/* Explicit leading: this caption wraps on a neutral switch, and the variant's line-height of 1 collides the lines. */}
              <Typography
                as="p"
                variant="label-medium-default"
                className="leading-[15px] text-[var(--content-tertiary)]"
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
              {copy.checklistHeading}
            </Typography>
            <ul className="flex flex-col gap-2">
              {details.highlights.map((row) => (
                <li key={row} className="flex items-center gap-1">
                  {/* Not --system-positive-strong: velvet restyles that token
                      to its pink accent, so a check would read as an error.
                      The plans takeover's checklist is neutral for the same
                      reason. */}
                  <CircleCheck
                    className="size-4 shrink-0 text-[var(--content-secondary)]"
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
          </Modal.Body>
        ) : null}
        {/* Outside the details gate: the note comes from the relation alone, and
            an unresolved target still offers the danger confirm. */}
        {copy.note ? (
          <Typography
            id={noteId}
            as="p"
            variant="body-medium-default"
            className="text-[var(--content-secondary)]"
          >
            {copy.note}
          </Typography>
        ) : null}
        <Modal.Footer className="flex-col gap-4 p-0">
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
            ref={cancelRef}
            fullWidth
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
          >
            {t("packageSwitchConfirmModal.cancel")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
