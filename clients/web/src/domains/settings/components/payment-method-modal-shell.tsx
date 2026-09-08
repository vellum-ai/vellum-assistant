/**
 * Presentational chrome for the payment-method modal: header, a slot for the
 * payment fields, the state slot (bank confirmation, success panel, or terms),
 * and the footer actions.
 *
 * It holds no Stripe dependency and no state of its own, so every combination
 * renders from props alone in tests and stories. The owner mounts the Stripe
 * elements as `children` and drives `state`.
 */
import { Loader2, X } from "lucide-react";
import { type ReactNode } from "react";

import { FIELD_STACK_CLASS } from "@/domains/settings/components/field-skeletons";
import {
  brandLabel,
  cardExpiryParts,
} from "@/domains/settings/utils/payment-method-brand";
import { useTranslation, type TFunction } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { cn } from "@vellumai/design-library/utils/cn";

export type PaymentMethodModalMode = "add" | "replace";

export type PaymentMethodModalState =
  "idle" | "submitting" | "requires_action" | "error" | "saved";

export interface CardOnFile {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface SavedCard {
  brand: string | null;
  last4: string | null;
}

export interface PaymentMethodModalShellProps {
  open: boolean;
  mode: PaymentMethodModalMode;
  state: PaymentMethodModalState;
  /** The card being replaced; named in the subtitle only in `replace` mode. */
  cardOnFile?: CardOnFile | null;
  /** The card just saved; titles the success panel in the `saved` state. */
  savedCard?: SavedCard | null;
  autoReloadActive?: boolean;
  /**
   * Drops the header in the `saved` state down to a screen-reader title, for
   * a redirect return that reopens straight into it with no mode to derive a
   * header from.
   */
  headerless?: boolean;
  errorMessage?: string | null;
  showTerms?: boolean;
  submitDisabled?: boolean;
  onClose: () => void;
  onSubmit?: () => void;
  children?: ReactNode;
}

/** A save is in flight, so the modal refuses every dismissal affordance. */
export function isLockedState(state: PaymentMethodModalState): boolean {
  return state === "submitting" || state === "requires_action";
}

export function PaymentMethodModalShell({
  open,
  mode,
  state,
  cardOnFile = null,
  savedCard = null,
  autoReloadActive = false,
  headerless = false,
  errorMessage = null,
  showTerms = false,
  submitDisabled = false,
  onClose,
  onSubmit,
  children,
}: PaymentMethodModalShellProps) {
  const { t } = useTranslation("settings");
  const locked = isLockedState(state);
  const isReplace = mode === "replace";
  const isSaved = state === "saved";
  const srOnlyHeader = isSaved && headerless;
  // Radix stamps `aria-describedby` at `Modal.Description`'s id whether or not
  // that element renders, so the dialog drops the attribute outright when the
  // header is down to a screen-reader title.
  const describedBy = srOnlyHeader ? { "aria-describedby": undefined } : {};
  // Once saved, the replaced card is history, so the subtitle drops the card it
  // was naming rather than reading as though the swap is still pending.
  const subtitle = isReplace
    ? replaceSubtitle(t, isSaved ? null : cardOnFile)
    : t("autoTopUpPaymentMethodModal.addSubtitle");

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !locked) {
          onClose();
        }
      }}
    >
      <Modal.Content
        size="sm"
        className="max-w-[420px] overflow-hidden rounded-xl p-0"
        hideCloseButton
        dismissOnOverlayClick={!locked}
        onEscapeKeyDown={locked ? (e) => e.preventDefault() : undefined}
        onInteractOutside={locked ? (e) => e.preventDefault() : undefined}
        {...describedBy}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-[18px]">
          <div className="min-w-0">
            {srOnlyHeader ? (
              <Modal.Title className="sr-only">
                {savedPanelTitle(t, savedCard)}
              </Modal.Title>
            ) : (
              <>
                <Modal.Title className="text-[18px] font-semibold tracking-[-0.02em] text-[var(--content-emphasised)]">
                  {isReplace
                    ? t("autoTopUpPaymentMethodModal.replaceTitle")
                    : t("autoTopUpPaymentMethodModal.addTitle")}
                </Modal.Title>
                <Modal.Description className="mt-[5px] text-[13px] leading-normal text-[var(--content-tertiary)]">
                  {subtitle}
                </Modal.Description>
              </>
            )}
          </div>
          <Modal.Close asChild>
            <button
              type="button"
              data-testid="payment-method-modal-close"
              aria-label={t("autoTopUpPaymentMethodModal.close")}
              disabled={locked}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-emphasised)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <X size={17} />
            </button>
          </Modal.Close>
        </div>

        <form
          id="payment-method-modal-form"
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit?.();
          }}
        >
          <Modal.Body
            className={cn(
              "flex flex-col gap-[14px] px-6",
              // With no actions to render, the footer is dropped and the body
              // carries the gutter under the success panel.
              isSaved ? "pb-[22px]" : "pb-0",
            )}
          >
            {isSaved ? null : (
              <div
                data-testid="payment-method-modal-fields"
                aria-busy={locked}
                className={cn(
                  FIELD_STACK_CLASS,
                  locked && "pointer-events-none opacity-45",
                )}
              >
                {children}
              </div>
            )}

            {errorMessage ? (
              <div
                data-testid="auto-top-up-pm-modal-confirm-error"
                className="flex items-start gap-2"
              >
                <span
                  aria-hidden
                  className="mt-[6px] h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--system-negative-strong)]"
                />
                <p className="text-[12.5px] leading-normal text-[var(--system-negative-on-weak)]">
                  {errorMessage}
                </p>
              </div>
            ) : null}

            {state === "requires_action" ? (
              <div
                data-testid="payment-method-modal-status-row"
                className="flex items-center gap-[10px] rounded-lg bg-[var(--surface-base)] px-[13px] py-3"
              >
                <Loader2
                  aria-hidden
                  size={14}
                  className="shrink-0 animate-spin text-[var(--system-info-strong)]"
                />
                <span className="text-[13px] text-[var(--content-secondary)]">
                  {t("autoTopUpPaymentMethodModal.confirmingWithBank")}
                </span>
              </div>
            ) : isSaved ? (
              <SavedPanel
                card={savedCard}
                autoReloadActive={autoReloadActive}
              />
            ) : showTerms ? (
              <p
                data-testid="payment-method-modal-terms"
                className="mt-1.5 text-[11.5px] leading-[1.55] text-[var(--content-quiet)]"
              >
                {isReplace
                  ? t("autoTopUpPaymentMethodModal.termsReplace")
                  : t("autoTopUpPaymentMethodModal.termsAdd")}
              </p>
            ) : null}
          </Modal.Body>

          {isSaved ? null : (
            <Modal.Footer className="flex flex-col gap-1 px-6 pt-[18px] pb-[22px]">
              <Button
                variant="primary"
                fullWidth
                type="submit"
                data-testid="auto-top-up-pm-save-button"
                className="h-auto rounded-lg py-[14px] text-[14.5px] font-semibold"
                disabled={submitDisabled || locked}
                leftIcon={
                  locked ? <Loader2 className="animate-spin" /> : undefined
                }
              >
                {locked
                  ? t("autoTopUpPaymentMethodModal.primarySubmitting")
                  : isReplace
                    ? t("autoTopUpPaymentMethodModal.primaryReplace")
                    : t("autoTopUpPaymentMethodModal.primaryAdd")}
              </Button>
              <Button
                variant="ghost"
                fullWidth
                type="button"
                className="h-auto rounded-md py-[10px] text-[13.5px] font-medium [--vbtn-fg:var(--content-tertiary)] hover:[--vbtn-fg:var(--content-emphasised)]"
                onClick={onClose}
                disabled={locked}
              >
                {t("autoTopUpPaymentMethodModal.cancel")}
              </Button>
            </Modal.Footer>
          )}
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * Names the card being replaced inside the replace subtitle.
 *
 * Each card shape reads a whole sentence from the catalog rather than having
 * one composed here around a standalone card label, so a locale that inflects
 * the card reference for the verb can write it that way. The brand-only shape
 * gets its own message too: dropping it into the brand-and-last4 sentence
 * would leave the dots dangling, and dropping it to the card-less copy would
 * throw away a brand we do know.
 *
 * A known expiry is a sibling sentence rather than a fragment spliced into the
 * one above, so its separator, spacing and position are the locale's to choose
 * and the raw month and year are all that cross the boundary.
 */
function replaceSubtitle(
  t: TFunction<"settings">,
  card: CardOnFile | null,
): string {
  const brand = brandLabel(card?.brand);
  const last4 = card?.last4;
  if (!brand && !last4) {
    return t("autoTopUpPaymentMethodModal.replaceSubtitle");
  }

  const expiry = cardExpiryParts(card?.expMonth, card?.expYear);

  if (!last4) {
    if (expiry) {
      return t("autoTopUpPaymentMethodModal.replaceSubtitleCardNoLast4Expiry", {
        brand,
        ...expiry,
      });
    }
    return t("autoTopUpPaymentMethodModal.replaceSubtitleCardNoLast4", {
      brand,
    });
  }
  if (!brand) {
    if (expiry) {
      return t("autoTopUpPaymentMethodModal.replaceSubtitleCardNoBrandExpiry", {
        last4,
        ...expiry,
      });
    }
    return t("autoTopUpPaymentMethodModal.replaceSubtitleCardNoBrand", {
      last4,
    });
  }
  if (expiry) {
    return t("autoTopUpPaymentMethodModal.replaceSubtitleCardExpiry", {
      brand,
      last4,
      ...expiry,
    });
  }
  return t("autoTopUpPaymentMethodModal.replaceSubtitleCard", {
    brand,
    last4,
  });
}

/**
 * Titles the success panel, and the screen-reader title above it.
 *
 * A brand we can name nothing for keeps the digits rather than dropping to the
 * card-less copy. Without the digits there is nothing to name the card by, so
 * a brand on its own reads as the card-less copy.
 */
function savedPanelTitle(
  t: TFunction<"settings">,
  card: SavedCard | null,
): string {
  const brand = brandLabel(card?.brand);
  const last4 = card?.last4;
  if (!last4) {
    return t("autoTopUpPaymentMethodModal.savedTitleGeneric");
  }
  if (!brand) {
    return t("autoTopUpPaymentMethodModal.savedTitleNoBrand", { last4 });
  }
  return t("autoTopUpPaymentMethodModal.savedTitle", { brand, last4 });
}

function SavedPanel({
  card,
  autoReloadActive,
}: {
  card: SavedCard | null;
  autoReloadActive: boolean;
}) {
  const { t } = useTranslation("settings");

  return (
    <div
      data-testid="payment-method-modal-saved"
      className="flex items-center gap-[11px] rounded-lg bg-[var(--system-positive-weak)] p-[13px]"
    >
      <span
        aria-hidden
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--system-positive-strong)] text-[12px] text-white"
      >
        ✓
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium text-[var(--system-positive-on-weak)]">
          {savedPanelTitle(t, card)}
        </p>
        {autoReloadActive ? (
          <p className="mt-px text-[12px] text-[var(--system-positive-on-weak)]">
            {t("autoTopUpPaymentMethodModal.savedSubtitle")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
