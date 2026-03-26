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
    /// Cancellable task that auto-dismisses publishError after a delay.
    var errorDismissTask: Task<Void, Never>?
}

/// Sidebar interaction state -- hover, rename, expand/collapse lists, drawer.
@Observable
@MainActor
final class SidebarInteractionState {
    var isHoveredConversation: UUID?
    var isHoveredApp: String?
    var renamingConversationId: UUID?
    var renameText: String = ""
    var showAllConversations: Bool = false
    var showAllScheduleConversations: Bool = false
    var showAllBackgroundConversations: Bool = false
    /// Set of schedule group keys (scheduleJobId values) that are currently expanded.
    var expandedScheduleGroups: Set<String> = []
    var showAllApps: Bool = false
    var showPreferencesDrawer: Bool = false

    /// Updates conversation hover state. Centralises the invariant so callers
    /// don't need to coordinate.
    ///
    /// During an active drag, hover updates are suppressed to avoid triggering
    /// icon-swap animations and unnecessary re-renders across sibling rows.
    func setConversationHover(conversationId: UUID?, hovering: Bool) {
        // Suppress hover changes while dragging to prevent visual jank.
        // When a hover-in arrives while dragging, the drag session must have
        // ended (SwiftUI resumes hover tracking only after the drag completes).
        // Clean up stale drag state so hover interactions resume.
        if draggingConversationId != nil {
            if hovering {
                draggingConversationId = nil
                dropTargetConversationId = nil
            } else {
                return
            }
        }

        if hovering {
            isHoveredConversation = conversationId
        } else {
            if isHoveredConversation == conversationId {
                isHoveredConversation = nil
            }
        }
    }

    /// Conversation ID that is currently the drop target during a drag-and-drop reorder.
    var dropTargetConversationId: UUID?
    /// Conversation ID currently being dragged (set on drag start, cleared on drop).
    var draggingConversationId: UUID?
    /// Whether the drop indicator should appear at the bottom of the target (true)
    /// or the top (false). Set based on drag direction.
    var dropIndicatorAtBottom: Bool = false
}
