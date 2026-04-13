import Foundation
import VellumAssistantShared

/// SSE subscription loop for ``HomeStore``.
///
/// Split out of the main file so the store body stays focused on state +
/// lifecycle, while this extension holds the async-iteration boilerplate.
/// The task handle lives on the store (`sseTask`) so `deinit` can cancel it.
extension HomeStore {
    /// Starts consuming the shared `ServerMessage` stream and triggers a
    /// reload whenever the daemon broadcasts `relationshipStateUpdated`.
    ///
    /// Invoked from `HomeStore.init` — safe to call exactly once per store.
    func startListening() {
        sseTask = Task { [weak self] in
            guard let self else { return }
            let stream = self.messageStream
            for await message in stream {
                if Task.isCancelled { break }
                if case .relationshipStateUpdated = message {
                    // Refresh the cached state, then raise the unseen-changes
                    // dot if the user is currently somewhere other than the
                    // Home tab. The daemon's SSE stream is unbuffered (verified
                    // in `assistant/src/runtime/assistant-event-hub.ts` —
                    // subscriptions do not replay historical events), so every
                    // event we receive corresponds to a real, post-connect
                    // state change. There is no startup replay to suppress.
                    //
                    // Cold-start safety: on app launch the first thing that
                    // happens is `load()` from the foreground observer (and a
                    // direct call from the Home page on appear). No SSE event
                    // fires during this window unless the daemon actively
                    // emits one — in which case the user IS off-surface and
                    // the dot is correct.
                    await self.load()
                    if !self.isHomeTabVisible {
                        self.flagUnseenChanges()
                    }
                }
            }
        }
    }
}
