import type { MouseEvent } from "react";

/** Touch browsers do not consistently focus buttons when they are tapped. */
export function openDetailSheetFromTrigger(
  event: MouseEvent<HTMLElement>,
  open: () => void,
): void {
  event.currentTarget.setAttribute("data-detail-sheet-trigger", "");
  event.currentTarget.focus({ preventScroll: true });
  open();
}
