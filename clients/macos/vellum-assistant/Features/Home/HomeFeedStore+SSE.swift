import Foundation
import VellumAssistantShared

/// SSE subscription loop for ``HomeFeedStore``.
///
/// Split out of the main file so the store body stays focused on state +
/// lifecycle, while this extension holds the async-iteration boilerplate.
/// The task handle lives on the store (`sseTask`) so `deinit` can cancel it.
extension HomeFeedStore {
    /// Starts consuming the shared `ServerMessage` stream and triggers a
    /// reload whenever the daemon broadcasts `homeFeedUpdated`.
    ///
    /// Invoked from `HomeFeedStore.init` — safe to call exactly once per
    /// store. Captures `messageStream` by value so the Task does NOT hold
    /// a reference to `self` for the lifetime of the loop; each iteration
    /// re-acquires `self` weakly, so `deinit` can still fire and cancel
    /// the task.
    func startListening() {
        let stream = self.messageStream
        sseTask = Task { [weak self] in
            for await message in stream {
                if Task.isCancelled { break }
                guard let self else { break }
                if case .homeFeedUpdated = message {
                    // Refresh the feed first so the next time the user
                    // opens Home the new items are already in `items`,
                    // then notify the wired-in callback (typically
                    // ``HomeStore.flagUnseenChanges()`` gated on
                    // off-surface visibility) so the toolbar's unread
                    // dot lights up on off-surface activity.
                    await self.load()
                    self.onSSEUpdate?()
                }
            }
        }
    }
}
