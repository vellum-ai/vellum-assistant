import AppKit
import Combine
import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadWindowManager")

/// Manages detached thread windows — threads opened in their own separate window.
@MainActor
final class ThreadWindowManager: ObservableObject {
    private let threadManager: ThreadManager
    private let daemonClient: DaemonClient
    private let settingsStore: SettingsStore

    /// Map of thread ID → detached window.
    private var windows: [UUID: ThreadWindow] = [:]

    /// Thread IDs that are currently open in a detached window.
    /// Published so the sidebar can show visual indicators.
    @Published private(set) var detachedThreadIds: Set<UUID> = []

    init(threadManager: ThreadManager, daemonClient: DaemonClient, settingsStore: SettingsStore) {
        self.threadManager = threadManager
        self.daemonClient = daemonClient
        self.settingsStore = settingsStore
    }

    /// Open a thread in a new window. If already open, focus the existing window.
    func openInNewWindow(threadId: UUID) {
        if let existing = windows[threadId] {
            existing.focus()
            return
        }

        guard let viewModel = threadManager.getOrCreateViewModel(forDetached: threadId) else {
            log.warning("Cannot open thread \(threadId) in new window — thread not found")
            return
        }

        // Pin the VM so LRU eviction doesn't kill it while the window is open
        threadManager.pinViewModel(threadId: threadId)

        let thread = threadManager.threads.first(where: { $0.id == threadId })
        let title = thread?.title ?? "Conversation"

        let window = ThreadWindow(
            threadId: threadId,
            title: title,
            viewModel: viewModel,
            daemonClient: daemonClient,
            settingsStore: settingsStore,
            onClose: { [weak self] in
                self?.handleWindowClosed(threadId: threadId)
            }
        )
        window.show()

        windows[threadId] = window
        detachedThreadIds.insert(threadId)
        log.info("Opened thread \(threadId) in new window")
    }

    /// Update the title of a detached window when the thread is renamed.
    func updateTitle(threadId: UUID, title: String) {
        windows[threadId]?.updateTitle(title)
    }

    /// Close a detached window programmatically (e.g. when thread is archived).
    func closeWindow(threadId: UUID) {
        windows[threadId]?.close()
        // handleWindowClosed will be called by the onClose callback
    }

    /// Whether a thread is currently open in a detached window.
    func isDetached(_ threadId: UUID) -> Bool {
        detachedThreadIds.contains(threadId)
    }

    /// Close all detached windows.
    func closeAll() {
        for (_, window) in windows {
            window.close()
        }
        // handleWindowClosed handles cleanup for each
    }

    private func handleWindowClosed(threadId: UUID) {
        windows.removeValue(forKey: threadId)
        detachedThreadIds.remove(threadId)
        threadManager.unpinViewModel(threadId: threadId)
        log.info("Closed detached window for thread \(threadId)")
    }
}
