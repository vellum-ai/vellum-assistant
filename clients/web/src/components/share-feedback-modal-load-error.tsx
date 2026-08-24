import { createPortal } from "react-dom";

import { Button } from "@vellumai/design-library/components/button";

import {
  SHARE_FEEDBACK_MODAL_BACKDROP_CLASS,
  SHARE_FEEDBACK_MODAL_PANEL_CLASS,
  SHARE_FEEDBACK_MODAL_PANEL_STYLE,
} from "@/components/share-feedback-modal-shell";
import { useTranslation } from "@/i18n";

export interface ShareFeedbackModalLoadErrorProps {
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Shown in place of the Share Feedback dialog when its chunk never arrives.
 *
 * Uses the dialog's own shell so the failure is visible where the dialog would
 * have been: the previous treatment was `LazyBoundary`'s inline paragraph,
 * which rendered inside whatever row mounted the modal and was clipped out of
 * sight.
 */
export function ShareFeedbackModalLoadError({
  onRetry,
  onClose,
}: ShareFeedbackModalLoadErrorProps) {
  const { t } = useTranslation();

  return createPortal(
    <div className={SHARE_FEEDBACK_MODAL_BACKDROP_CLASS}>
      <div
        role="alert"
        className={SHARE_FEEDBACK_MODAL_PANEL_CLASS}
        style={SHARE_FEEDBACK_MODAL_PANEL_STYLE}
      >
        <p className="text-body-medium-lighter text-[var(--content-default)]">
          {t("shareFeedbackModalLoadError.message")}
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("shareFeedbackModalLoadError.close")}
          </Button>
          <Button variant="primary" onClick={onRetry}>
            {t("shareFeedbackModalLoadError.retry")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
