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

/// Sidebar interaction state — cross-row concerns (drag, rename, expand/collapse).
/// Per-row affordances (hover, menu) are owned locally by each `SidebarConversationItem`.
@Observable
@MainActor
final class SidebarInteractionState {
    var isHoveredApp: String?
    var renamingConversationId: UUID?
    var renameText: String = ""
    /// Set of group IDs whose sections are currently expanded.
    /// Defaults to showing the pinned section expanded.
    var expandedSections: Set<String> = {
        // Migrate from old per-section booleans on first access.
        let defaults = UserDefaults.standard
        var initial: Set<String> = []

        // If we have persisted expandedSections, use those.
        if let saved = defaults.stringArray(forKey: "sidebar.expandedSections") {
            initial = Set(saved)
        } else {
            // First-launch defaults: all system groups expanded.
            initial = [
                ConversationGroup.pinned.id,
                ConversationGroup.scheduled.id,
                ConversationGroup.background.id,
            ]
        }

        // Clean up old keys (one-time migration).
        for key in ["showAllConversations", "showAllScheduleConversations", "showAllBackgroundConversations"] {
            defaults.removeObject(forKey: key)
        }

        return initial
    }() {
        didSet {
            UserDefaults.standard.set(Array(expandedSections), forKey: "sidebar.expandedSections")
        }
    }

    /// Set of group IDs where "Show more" has been toggled on.
    var showAllInSection: Set<String> = []

    /// Group ID currently targeted during a drag-and-drop operation.
    var dropTargetSectionId: String?

    /// Set of schedule group keys (scheduleJobId values) that are currently expanded.
    var expandedScheduleGroups: Set<String> = []
    var showAllApps: Bool = false

    /// Toggles the expand/collapse state of a section.
    func toggleSection(_ groupId: String) {
        if expandedSections.contains(groupId) {
            expandedSections.remove(groupId)
        } else {
            expandedSections.insert(groupId)
        }
    }

    /// Toggles the show-all/show-less state of a section.
    func toggleShowAll(_ groupId: String) {
        if showAllInSection.contains(groupId) {
            showAllInSection.remove(groupId)
        } else {
            showAllInSection.insert(groupId)
        }
    }

    var showPreferencesDrawer: Bool = false

    /// Clears stale drag state. Called as a fallback when a post-drag hover-in
    /// is detected by a conversation row, indicating the drag session ended
    /// without a successful drop (e.g., dropped outside any valid target).
    func clearStaleDragState() {
        guard draggingConversationId != nil else { return }
        draggingConversationId = nil
        dropTargetConversationId = nil
    }

    /// Conversation ID that is currently the drop target during a drag-and-drop reorder.
    var dropTargetConversationId: UUID?
    /// Conversation ID currently being dragged (set on drag start, cleared on drop).
    var draggingConversationId: UUID?
    /// Whether the drop indicator should appear at the bottom of the target (true)
    /// or the top (false). Set based on drag direction.
    var dropIndicatorAtBottom: Bool = false

    // MARK: - Group Rename State

    /// Group ID currently being renamed inline. Set when "Rename" is selected from context menu.
    var renamingGroupId: String?
    /// Text field content for the group currently being renamed.
    var renamingGroupName: String = ""
}
