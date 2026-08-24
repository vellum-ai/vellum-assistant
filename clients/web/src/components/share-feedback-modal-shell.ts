import type { CSSProperties } from "react";

/**
 * Geometry of the Share Feedback dialog, shared by the modal itself and by the
 * placeholders shown while its lazy chunk is in flight.
 *
 * Kept in its own module with no import of the modal, so a consumer can render
 * the shell without pulling the chunk this file exists to defer.
 */
export const SHARE_FEEDBACK_MODAL_BACKDROP_CLASS =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/50";

export const SHARE_FEEDBACK_MODAL_PANEL_CLASS =
  "mx-4 flex w-full max-w-lg flex-col rounded-xl border p-6 shadow-xl";

export const SHARE_FEEDBACK_MODAL_PANEL_STYLE: CSSProperties = {
  backgroundColor: "var(--surface-lift)",
  borderColor: "var(--border-base)",
  maxHeight: "calc(100vh - 2rem)",
};
