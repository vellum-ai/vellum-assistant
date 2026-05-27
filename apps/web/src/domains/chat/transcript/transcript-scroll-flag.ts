// Runtime flag that turns OFF the deprecated transcript scroll hook.
//
// This file is intentionally isolated from the rest of the scroll
// utilities so it can be deleted in one move when the migration is
// complete — no other file in `transcript/` depends on it except
// `use-deprecated-transcript-scroll.ts` and `transcript-scroll.ts`,
// both of which will be deleted/refactored at that point.
//
// In the current shape of this work-in-progress:
//
//   • Flag OFF (default) — the orchestrator runs the deprecated hook
//     `useDeprecatedTranscriptScroll`, which is the existing
//     production scroll-coordination logic. Production users land
//     here. We keep this in the tree so we don't regress shipping
//     behavior while we redesign the replacement.
//   • Flag ON  — the deprecated hook returns its no-op result. The
//     replacement utilities in `transcript-scroll.ts` take over
//     piecewise as features migrate.
//
// Why module-load read + reload-on-toggle:
//
//   • React forbids conditionally calling different hooks across
//     renders. By making the dispatch decision once at module-import
//     time (before any component mounts), the dispatcher resolves to a
//     single function identity for the entire page lifetime.
//   • Toggling without a reload would leave the DOM in an inconsistent
//     intermediate state (scroll listeners attached but no longer
//     handled, in-flight auto-pin timers orphaned). A page reload is
//     cheap and dev-only.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   toggleTranscriptScrollController()       — flip current value
//   toggleTranscriptScrollController(true)   — force on
//   toggleTranscriptScrollController(false)  — force off

const STORAGE_KEY = "vellumDebug.flags.transcriptScrollController";

/** Read the flag synchronously. Safe to call at module-load time. */
export function getTranscriptScrollControllerEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Private-browsing modes or sandboxed contexts can throw on
    // localStorage access. Treat any throw as "flag off".
    return false;
  }
}

/** Persist the flag, log the new value, and reload the page so the
 *  dispatcher re-resolves. `value === undefined` flips the current
 *  value (the most common interactive case). */
export function setTranscriptScrollControllerEnabled(value?: boolean): boolean {
  if (typeof window === "undefined") return false;
  const next =
    value === undefined ? !getTranscriptScrollControllerEnabled() : !!value;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Persistence failed — log and bail so the user knows their
    // toggle didn't stick.
    console.warn(
      "[vellumDebug] failed to persist transcriptScrollController flag",
    );
    return getTranscriptScrollControllerEnabled();
  }
  console.info(
    `[vellumDebug] transcriptScrollController = ${next} — reloading…`,
  );
  window.location.reload();
  return next;
}

/** The flag value resolved exactly once at module load. The
 *  dispatcher reads this constant so hook-rule order stays stable
 *  across the page lifetime. */
export const TRANSCRIPT_SCROLL_CONTROLLER_ENABLED =
  getTranscriptScrollControllerEnabled();
