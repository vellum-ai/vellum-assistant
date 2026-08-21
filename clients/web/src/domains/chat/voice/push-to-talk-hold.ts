/**
 * Whether a push-to-talk hold is currently recording. Shared so the voice
 * mode tap listener can tell a release that ends a dictation hold from a
 * clean tap when both are bound to the same modifier.
 */
let holdActive = false;

export function isPushToTalkHoldActive(): boolean {
  return holdActive;
}

export function setPushToTalkHoldActive(active: boolean): void {
  holdActive = active;
}
