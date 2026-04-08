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
            // First-launch defaults: Recents expanded so conversations are visible.
            initial = [ConversationGroup.all.id]
        }

        // One-time migration: expand system:all for existing users upgrading
        // from before the Recents group existed. Gated by a flag so it only
        // runs once and doesn't override the user's collapse preference.
        let migrationKey = "sidebar.systemAllExpandedMigrated"
        if !defaults.bool(forKey: migrationKey) {
            initial.insert(ConversationGroup.all.id)
            // Persist immediately — didSet won't fire for the initial closure
            // assignment, so without this the next launch loads the old list.
            defaults.set(Array(initial), forKey: "sidebar.expandedSections")
            defaults.set(true, forKey: migrationKey)
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
    /// Group ID where a forbidden drop indicator is active (e.g. Scheduled during conversation drag).
    var dropForbiddenSectionId: String?
    /// Group ID currently being dragged (set on drag start via .onDrag).
    var draggingGroupId: String?
    /// Whether the group drop indicator should appear at the bottom (true) or top (false).
    var groupDropIndicatorAtBottom: Bool = false

    /// Set of channel names whose sidebar sections are currently collapsed.
    /// Persisted to UserDefaults so collapse state survives app restart.
    var collapsedChannelSections: Set<String> = {
        let saved = UserDefaults.standard.stringArray(forKey: "collapsedChannelSections") ?? []
        return Set(saved)
    }() {
        didSet {
            UserDefaults.standard.set(Array(collapsedChannelSections), forKey: "collapsedChannelSections")
        }
    }

    /// Per-channel "show all" toggle (default: show first 3).
    var showAllChannelConversations: [String: Bool] = [:]
    /// Set of schedule sub-group keys (scheduleJobId values) that are currently expanded.
    var expandedScheduleGroups: Set<String> = []
    /// Set of background sub-group keys (source values) that are currently expanded.
    var expandedBackgroundGroups: Set<String> = []
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

    @ObservationIgnored private var dragEndLocalMonitor: Any?
    @ObservationIgnored private var dragEndGlobalMonitor: Any?

    /// Begins a conversation drag session and installs a temporary mouse-up monitor
    /// so canceled drags are cleaned up reliably.
    func beginConversationDrag(_ conversationId: UUID) {
        draggingConversationId = conversationId
        installDragEndMonitorIfNeeded()
    }

    /// Ends the current conversation drag session and clears all drop targeting state.
    func endConversationDrag() {
        draggingConversationId = nil
        dropTargetConversationId = nil
        dropTargetSectionId = nil
        dropForbiddenSectionId = nil
        removeDragEndMonitor()
    }

    /// Clears stale drag state if a drag session is still active.
    func clearStaleDragState() {
        guard draggingConversationId != nil else {
            removeDragEndMonitor()
            return
        }
        endConversationDrag()
    }

    /// Conversation ID that is currently the drop target during a drag-and-drop reorder.
    var dropTargetConversationId: UUID?
    /// Conversation ID currently being dragged (set on drag start, cleared on drop).
    var draggingConversationId: UUID?
    /// Whether the drop indicator should appear at the bottom of the target (true)
    /// or the top (false). Set based on drag direction.
    var dropIndicatorAtBottom: Bool = false

    // MARK: - Group Rename State

    /// Group ID currently being renamed. Set when "Rename" is selected from context menu.
    var renamingGroupId: String?
    /// Text field content for the group currently being renamed.
    var renamingGroupName: String = ""

    private func installDragEndMonitorIfNeeded() {
        guard dragEndLocalMonitor == nil, dragEndGlobalMonitor == nil else { return }

        dragEndLocalMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseUp, .rightMouseUp, .otherMouseUp]
        ) { [weak self] event in
            Task { @MainActor in
                self?.clearStaleDragState()
            }
            return event
        }

        dragEndGlobalMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseUp, .rightMouseUp, .otherMouseUp]
        ) { [weak self] _ in
            Task { @MainActor in
                self?.clearStaleDragState()
            }
        }
    }

    private func removeDragEndMonitor() {
        if let dragEndLocalMonitor {
            NSEvent.removeMonitor(dragEndLocalMonitor)
            self.dragEndLocalMonitor = nil
        }
        if let dragEndGlobalMonitor {
            NSEvent.removeMonitor(dragEndGlobalMonitor)
            self.dragEndGlobalMonitor = nil
        }
    }
}
