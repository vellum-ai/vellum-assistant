"use client";

// Ref-counted body scroll lock shared by the nav drawer and the search
// spotlight. Counting means whichever overlay closes first cannot unlock the
// body while the other still holds it.
let lockCount = 0;

export function lockBodyScroll(): void {
  lockCount += 1;
  document.body.style.overflow = "hidden";
}

export function unlockBodyScroll(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = "";
  }
}
