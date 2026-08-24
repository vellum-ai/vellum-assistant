import { createPortal } from "react-dom";

import { Skeleton } from "@vellumai/design-library/components/skeleton";

import {
  SHARE_FEEDBACK_MODAL_BACKDROP_CLASS,
  SHARE_FEEDBACK_MODAL_PANEL_CLASS,
  SHARE_FEEDBACK_MODAL_PANEL_STYLE,
} from "@/components/share-feedback-modal-shell";
import { useTranslation } from "@/i18n";

/**
 * Suspense fallback for the lazily-loaded Share Feedback dialog.
 *
 * Renders the dialog's own shell around a skeleton of the form, so a tap lands
 * on the surface it asked for while the chunk is still in flight. Portalled to
 * `document.body` for the same reason the modal is: a transformed ancestor
 * would otherwise resolve `position: fixed` against itself and the placeholder
 * would jump when the real dialog arrives.
 */
export function ShareFeedbackModalFallback() {
  const { t } = useTranslation();

  return createPortal(
    <div className={SHARE_FEEDBACK_MODAL_BACKDROP_CLASS}>
      <div
        role="status"
        aria-label={t("shareFeedbackModalFallback.loadingAria")}
        className={SHARE_FEEDBACK_MODAL_PANEL_CLASS}
        style={SHARE_FEEDBACK_MODAL_PANEL_STYLE}
      >
        <div
          className="flex items-center border-b pb-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <Skeleton className="h-5 w-2/5" />
        </div>

        <div className="flex flex-col gap-3.5 pt-4">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-4 w-3/5" />
        </div>

        <div
          className="mt-4 flex items-center justify-end border-t pt-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
