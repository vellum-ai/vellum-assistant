import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ThreadWindowManager")

/// Manages pop-out thread windows. Tracks open windows, prevents duplicates,
/// and coordinates ViewModel pinning with `ConversationManager` to prevent
/// LRU eviction of ViewModels backing open windows.
@MainActor
final class ThreadWindowManager {
    private let services: AppServices
    private var threadWindows: [UUID: ThreadWindow] = [:]

    /// Returns the set of conversation local IDs that have open pop-out windows.
    var openConversationIds: Set<UUID> {
        Set(threadWindows.keys)
    }

    init(services: AppServices) {
        self.services = services
    }

    /// Open (or focus) a pop-out window for the given conversation.
    /// Returns `true` if a new window was created, `false` if an existing one was focused.
    @discardableResult
    func openThread(
        conversationLocalId: UUID,
        conversationManager: ConversationManager
    ) -> Bool {
        // Focus existing window if already open
        if let existing = threadWindows[conversationLocalId] {
            existing.show(
                viewModel: dummyViewModel(), // won't actually re-create — show() is idempotent
                conversationManager: conversationManager,
                settingsStore: services.settingsStore,
                ambientAgent: services.ambientAgent,
                connectionManager: services.connectionManager,
                eventStreamClient: services.connectionManager.eventStreamClient,
                zoomManager: services.zoomManager
            )
            return false
        }

        // Get or create the ViewModel for this conversation
        guard let viewModel = conversationManager.viewModelForDetachedWindow(conversationLocalId: conversationLocalId) else {
            log.error("Cannot open thread window: no conversation found for \(conversationLocalId)")
            return false
        }

        // Pin the ViewModel so it won't be LRU-evicted
        conversationManager.pinViewModel(conversationLocalId)

        let threadWindow = ThreadWindow(conversationLocalId: conversationLocalId)
        threadWindow.onClose = { [weak self, weak conversationManager] in
            guard let self, let conversationManager else { return }
            self.threadWindows.removeValue(forKey: conversationLocalId)
            conversationManager.unpinViewModel(conversationLocalId)
            log.info("Thread window cleaned up for \(conversationLocalId), \(self.threadWindows.count) remaining")
        }

        threadWindow.show(
            viewModel: viewModel,
            conversationManager: conversationManager,
            settingsStore: services.settingsStore,
            ambientAgent: services.ambientAgent,
            connectionManager: services.connectionManager,
            eventStreamClient: services.connectionManager.eventStreamClient,
            zoomManager: services.zoomManager
        )

        threadWindows[conversationLocalId] = threadWindow
        viewModel.ensureMessageLoopStarted()

        log.info("Opened thread window for \(conversationLocalId), \(self.threadWindows.count) total")
        return true
    }

    /// Close all pop-out windows. Used during logout, auth reset, etc.
    func closeAll() {
        let ids = Array(threadWindows.keys)
        for id in ids {
            threadWindows[id]?.close()
        }
        threadWindows.removeAll()
        log.info("Closed all thread windows")
    }

    /// Close the pop-out window for a specific conversation (e.g. on archival/deletion).
    func closeThread(conversationLocalId: UUID) {
        threadWindows[conversationLocalId]?.close()
        threadWindows.removeValue(forKey: conversationLocalId)
    }

    /// Returns true if the given conversation has an open pop-out window.
    func isOpen(conversationLocalId: UUID) -> Bool {
        threadWindows[conversationLocalId] != nil
    }

    /// Update the title of an open thread window.
    func updateTitle(conversationLocalId: UUID, title: String) {
        threadWindows[conversationLocalId]?.updateTitle(title)
    }

    // Dummy ViewModel used only when refocusing an existing window
    // (the show() method is idempotent and won't use it).
    private func dummyViewModel() -> ChatViewModel {
        ChatViewModel(connectionManager: services.connectionManager, eventStreamClient: services.connectionManager.eventStreamClient)
    }
}
