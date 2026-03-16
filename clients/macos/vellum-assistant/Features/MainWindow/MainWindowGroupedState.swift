import AppKit
import Foundation
import SwiftUI
import VellumAssistantShared

// MARK: - Grouped State

/// Sharing/publishing state -- isolates workspace share and publish mutations
/// so they don't invalidate unrelated parts of MainWindowView.
@Observable
@MainActor
final class SharingState {
    var showSharePicker = false
    var isBundling = false
    var shareFileURL: URL?
    var shareAppName: String = ""
    var shareAppIcon: NSImage?
    var shareAppId: String?
    var isPublishing = false
    var publishedUrl: String?
    var publishError: String?
    var workspaceEditorContentHeight: CGFloat = 20
    /// Saved publish params for auto-retry after credential setup completes.
    var pendingPublish: (html: String, title: String?, appId: String?)?
    /// Timer for polling credential availability during setup flow.
    var credentialPollTimer: Timer?
    /// Stashed handler so onDisappear can restore it when polling is active.
    var previousVercelHandler: ((VercelApiConfigResponseMessage) -> Void)?
    /// Cancellable task that auto-dismisses publishError after a delay.
    var errorDismissTask: Task<Void, Never>?
}

/// Sidebar interaction state -- hover, rename, expand/collapse lists, drawer.
@Observable
@MainActor
final class SidebarInteractionState {
    var isHoveredThread: UUID?
    var isHoveredApp: String?
    var threadPendingDeletion: UUID?
    var renamingThreadId: UUID?
    var renameText: String = ""
    var showAllThreads: Bool = false
    var showAllScheduleThreads: Bool = false
    /// Set of schedule group keys (scheduleJobId values) that are currently expanded.
    var expandedScheduleGroups: Set<String> = []
    var showAllApps: Bool = false
    var showPreferencesDrawer: Bool = false

    /// Updates thread hover state and clears stale pending-deletion when hover
    /// moves to a different thread. Centralises the invariant so callers don't
    /// need to coordinate.
    func setThreadHover(threadId: UUID?, hovering: Bool) {
        if hovering {
            // Moving to a new thread clears pending archive of the old one
            if let pending = threadPendingDeletion, pending != threadId {
                threadPendingDeletion = nil
            }
            isHoveredThread = threadId
        } else {
            if isHoveredThread == threadId {
                isHoveredThread = nil
            }
            // Leaving a pending-deletion thread clears the confirmation
            if threadPendingDeletion == threadId {
                threadPendingDeletion = nil
            }
        }
    }

    /// Conversation ID that is currently the drop target during a drag-and-drop reorder.
    var dropTargetThreadId: UUID?
    /// Conversation ID currently being dragged (set on drag start, cleared on drop).
    var draggingThreadId: UUID?
    /// Whether the drop indicator should appear at the bottom of the target (true)
    /// or the top (false). Set based on drag direction.
    var dropIndicatorAtBottom: Bool = false
}
