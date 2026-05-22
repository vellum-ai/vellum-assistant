/**
 * Module-level gate that suppresses conversation-list refetches while a
 * draft conversation send is in flight. Without this, SSE-triggered
 * refetches replace the TanStack Query cache with server data that does
 * not include the client-side draft entry, evicting it and resetting
 * the active view.
 *
 * sendMessage increments before the POST and decrements after draft key
 * resolution (or on error). refreshConversations and sync-stream
 * refetch handlers check before invalidating the chatContext query.
 */

let _draftSendsInFlight = 0;

export function markDraftSendStart(): void {
  _draftSendsInFlight++;
}

export function markDraftSendEnd(): void {
  _draftSendsInFlight = Math.max(0, _draftSendsInFlight - 1);
}

export function hasDraftSendInFlight(): boolean {
  return _draftSendsInFlight > 0;
}
