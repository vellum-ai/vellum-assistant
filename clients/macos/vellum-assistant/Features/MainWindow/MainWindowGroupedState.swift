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
    /// In-flight hover work item — cancelled when a newer hover event arrives
    /// so that only the latest intent takes effect.
    private var pendingHoverWork: DispatchWorkItem?
    var isHoveredApp: String?
    var renamingConversationId: UUID?
    var renameText: String = ""
    var showAllConversations: Bool = false
    var showAllScheduleConversations: Bool = false
    var showAllBackgroundConversations: Bool = false
    var scheduleSectionCollapsed: Bool = false
    var backgroundSectionCollapsed: Bool = false
    /// Set of schedule group keys (scheduleJobId values) that are currently expanded.
    var expandedScheduleGroups: Set<String> = []
    var showAllApps: Bool = false
    var showPreferencesDrawer: Bool = false

    /// Updates conversation hover state. Centralises the invariant so callers
    /// don't need to coordinate.
    ///
    /// During an active drag, hover updates are suppressed to avoid triggering
    /// icon-swap animations and unnecessary re-renders across sibling rows.
    ///
    /// The actual mutation is deferred to the next run-loop cycle via
    /// `DispatchQueue.main.async`. This breaks a synchronous feedback loop:
    /// when SwiftUI re-evaluates hover state during a layout pass
    /// (`HoverResponder.updatePhase`), a synchronous `@Observable` mutation
    /// triggers `ObservationRegistrar.willSet` → `GraphHost.flushTransactions`,
    /// starting a nested layout pass that re-evaluates hover — and because
    /// the value genuinely alternates (UUID ↔ nil) on each cycle, an equality
    /// guard alone cannot stop the loop. Deferring ensures the mutation
    /// happens outside the current layout transaction.
    ///
    /// `SidebarConversationItem` applies `.animation(VAnimation.fast, value:
    /// isHovered)`, so the one-tick deferral is visually imperceptible.
    ///
    /// - SeeAlso: [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
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

        let newValue: UUID? = hovering
            ? conversationId
            : (isHoveredConversation == conversationId ? nil : isHoveredConversation)

        // Cancel any in-flight hover work — only the latest intent matters.
        // This prevents a deferred hover-out from clobbering a rapid hover-in
        // that arrives in the same run-loop tick.
        pendingHoverWork?.cancel()
        pendingHoverWork = nil

        guard isHoveredConversation != newValue else { return }

        // Defer to next run-loop tick to escape any in-progress layout pass.
        // Re-check the guard inside the closure in case another event
        // already updated the value before this block executes.
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.draggingConversationId == nil, self.isHoveredConversation != newValue else { return }
            self.isHoveredConversation = newValue
        }
        pendingHoverWork = work
        DispatchQueue.main.async(execute: work)
    }

    /// Conversation ID that is currently the drop target during a drag-and-drop reorder.
    var dropTargetConversationId: UUID?
    /// Conversation ID currently being dragged (set on drag start, cleared on drop).
    var draggingConversationId: UUID?
    /// Whether the drop indicator should appear at the bottom of the target (true)
    /// or the top (false). Set based on drag direction.
    var dropIndicatorAtBottom: Bool = false
}
