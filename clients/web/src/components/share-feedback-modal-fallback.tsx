import { Modal } from "@vellumai/design-library/components/modal";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { useTranslation } from "@/i18n";

export interface ShareFeedbackModalFallbackProps {
  onClose: () => void;
}

/**
 * Suspense fallback for the lazily-loaded Share Feedback dialog.
 *
 * Renders a skeleton of the form, so a tap lands on the surface it asked for
 * while the chunk is still in flight. Built on the design library's modal for
 * the same reason the load failure is: that is what supplies the focus trap,
 * escape-to-dismiss, and dialog semantics. A bare portalled backdrop supplies
 * none of them, so a chunk that takes a while covers the page with something
 * the user cannot leave and cannot tab out of the way of.
 *
 * The title is what a screen reader announces on open and the only element
 * Radix needs to name the dialog. It is visually hidden because the skeleton
 * stands in for the heading on screen. `aria-describedby` is cleared because
 * nothing further describes it.
 *
 * Radix's close-autofocus is left alone. It restores focus to a
 * `Modal.Trigger`, and there is none here, so the dialog that Suspense swaps
 * in as this unmounts keeps the focus it gives itself.
 */
export function ShareFeedbackModalFallback({
  onClose,
}: ShareFeedbackModalFallbackProps) {
  const { t } = useTranslation();

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      {/* max-w-lg pins the placeholder to the real dialog's width (its panel
          is max-w-lg, 512px) so the swap-in does not visibly resize. */}
      <Modal.Content
        size="md"
        className="max-w-lg"
        hideCloseButton
        aria-describedby={undefined}
      >
        <Modal.Header className="pr-4">
          <Modal.Title className="sr-only">
            {t("shareFeedbackModalFallback.loadingAria")}
          </Modal.Title>
          <Skeleton className="h-5 w-2/5" />
        </Modal.Header>

        <Modal.Body role="status" className="flex flex-col gap-3.5">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-4 w-3/5" />
        </Modal.Body>

        <Modal.Footer>
          <Skeleton className="h-9 w-24 rounded-lg" />
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
