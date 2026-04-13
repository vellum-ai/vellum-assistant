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
                    // Capture the cold-load sentinel BEFORE `load()` flips it
                    // so the initial fetch never lights up the unseen-changes
                    // dot. Events that arrive while the Home tab is already
                    // visible leave the flag alone — the user is looking at
                    // the new state as it lands.
                    let wasFirstLoad = !self.hasLoadedOnce
                    await self.load()
                    if !wasFirstLoad && !self.isHomeTabVisible {
                        self.flagUnseenChanges()
                    }
                }
            }
        }
    }
}
