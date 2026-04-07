import SwiftUI
import VellumAssistantShared

/// A single conversation row in the sidebar, handling hover, pin, archive, rename,
/// and drag interactions.
///
/// Hover state is owned locally via `@State` so it resets automatically when the
/// view's identity changes (e.g., conversation moves between ForEach sections on
/// pin/unpin). Props and action closures use `Equatable` to skip re-evaluation.
struct SidebarConversationItem: View, Equatable {
    let conversation: ConversationModel
    let isSelected: Bool
    let interactionState: ConversationInteractionState

    // Action closures — not compared in Equatable
    var selectConversation: () -> Void
    var onSelect: (() -> Void)? = nil
    var onTogglePin: () -> Void
    var onArchive: () -> Void
    var onStartRename: () -> Void
    var onMarkUnread: () -> Void
    var onDragStart: () -> Void
    var onAnalyze: (() -> Void)?
    var onOpenInNewWindow: (() -> Void)?
    var onShowFeedback: (() -> Void)?
    /// Available groups for the "Move to" submenu. Excludes the conversation's current group.
    var moveToGroups: [ConversationGroup] = []
    /// Moves the conversation to the specified group (nil = ungrouped).
    var onMoveToGroup: ((String?) -> Void)? = nil

    static func == (lhs: SidebarConversationItem, rhs: SidebarConversationItem) -> Bool {
        lhs.conversation == rhs.conversation &&
        lhs.isSelected == rhs.isSelected &&
        lhs.interactionState == rhs.interactionState &&
        lhs.moveToGroups == rhs.moveToGroups
    }

    /// The conversation's current group (if any), used for "Remove from group" visibility.
    private var moveToCurrentGroup: ConversationGroup? {
        guard let gid = conversation.groupId else { return nil }
        // The moveToGroups list excludes the current group, so check all system groups + search moveToGroups
        // by looking at the conversation's groupId against known groups.
        if gid == ConversationGroup.pinned.id { return ConversationGroup.pinned }
        if gid == ConversationGroup.scheduled.id { return ConversationGroup.scheduled }
        if gid == ConversationGroup.background.id { return ConversationGroup.background }
        if gid == ConversationGroup.all.id { return ConversationGroup.all }
        // Custom group — not in moveToGroups (it's filtered out), but we know it's non-system
        return ConversationGroup(id: gid, name: "", sortPosition: 0, isSystemGroup: false)
    }

    @State private var isMouseInside: Bool = false
    @State private var isMenuOpen: Bool = false

    /// Effective hover state, used throughout the body for visual affordances.
    private var isHovered: Bool { isMouseInside }
    private var hasTrailingIcon: Bool { isHovered || isMenuOpen }
    private var canMarkUnread: Bool {
        !conversation.hasUnseenLatestAssistantMessage &&
            !conversation.shouldSuppressUnreadIndicator &&
            conversation.conversationId != nil &&
            conversation.latestAssistantMessageAt != nil
    }

    @ViewBuilder
    private var contextMenuContent: some View {
        VMenuItem(icon: conversation.isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue, label: conversation.isPinned ? "Unpin" : "Pin") {
            onTogglePin()
        }

        VMenuItem(icon: VIcon.pencil.rawValue, label: "Rename") {
            onStartRename()
        }

        if !conversation.isChannelConversation {
            VMenuItem(icon: VIcon.archive.rawValue, label: "Archive") {
                onArchive()
            }
            VMenuItem(icon: VIcon.circle.rawValue, label: "Mark as unread") {
                onMarkUnread()
            }
            .disabled(!canMarkUnread)
        }

        if !conversation.isChannelConversation && conversation.kind != .private, let onAnalyze {
            VMenuItem(icon: VIcon.sparkles.rawValue, label: "Analyze") {
                onAnalyze()
            }
        }

        if !moveToGroups.isEmpty, let onMoveToGroup {
            VSubMenuItem(icon: VIcon.folder.rawValue, label: "Move to") {
                ForEach(moveToGroups) { group in
                    VMenuItem(label: group.name) {
                        onMoveToGroup(group.id)
                    }
                }
                if let gid = conversation.groupId, !gid.hasPrefix("system:") {
                    VMenuDivider()
                    VMenuItem(label: "Remove from group") {
                        onMoveToGroup(ConversationGroup.all.id)
                    }
                }
            }
        }

        if let onOpenInNewWindow {
            VMenuItem(icon: VIcon.externalLink.rawValue, label: "Open in New Window") {
                onOpenInNewWindow()
            }
        }

        VMenuDivider()

        VMenuItem(icon: VIcon.messageCircle.rawValue, label: "Share Feedback") {
            onShowFeedback?()
        }
        .disabled(onShowFeedback == nil)
    }

    var body: some View {
        // Use a tap gesture instead of Button so .onDrag can coexist —
        // Button captures mouse-down and prevents drag initiation on macOS.
        HStack(spacing: VSpacing.xs) {
            // Leading 20x20 slot: always shows the status indicator.
            // The pin button is rendered as a leading overlay (after .onTapGesture)
            // so it has hit-test priority on macOS. When hovered, the overlay pin
            // icon covers this slot visually.
            switch interactionState {
            case .processing:
                VBusyIndicator()
                    .frame(width: 20, height: 20)
                    .nativeTooltip("Processing")
                    .accessibilityLabel("Processing")
            case .waitingForInput:
                VIconView(.circleAlert, size: 12)
                    .foregroundStyle(VColor.systemMidStrong)
                    .frame(width: 20, height: 20)
                    .nativeTooltip("Waiting for input")
                    .accessibilityLabel("Waiting for input")
            case .error:
                VIconView(.circleAlert, size: 12)
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .frame(width: 20, height: 20)
                    .nativeTooltip("Error")
                    .accessibilityLabel("Error")
                    .transition(.opacity)
            case .idle:
                if conversation.hasUnseenLatestAssistantMessage {
                    VBadge(style: .dot, color: VColor.systemMidStrong)
                        .accessibilityLabel("Unread")
                        .frame(width: 20, height: 20)
                        .nativeTooltip("Unread")
                        .transition(.opacity)
                } else {
                    Color.clear
                        .frame(width: 20, height: 20)
                        .accessibilityLabel(conversation.isPinned ? "Pinned" : "")
                }
            }
            if conversation.kind == .private {
                VIconView(.lock, size: 13)
                    .foregroundStyle(VColor.primaryBase.opacity(0.7))
                    .nativeTooltip("Private conversation")
                    .accessibilityLabel("Private conversation")
            }
            VMarqueeText(
                text: conversation.title,
                font: VFont.bodyMediumDefault,
                measuringFont: VFont.nsBodyMediumDefault,
                foregroundStyle: isSelected ? VColor.contentEmphasized : VColor.contentSecondary,
                isHovered: isHovered
            )

        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, hasTrailingIcon ? SidebarLayoutMetrics.trailingIconPadding : VSpacing.sm)
        .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
        .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
        .background {
            if isSelected {
                VColor.surfaceActive
            } else if isHovered || isMenuOpen {
                VColor.surfaceBase
            } else if conversation.kind == .private {
                VColor.primaryBase.opacity(0.04)
            } else {
                VColor.surfaceBase.opacity(0)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .contentShape(Rectangle())
        .animation(VAnimation.fast, value: isMouseInside)
        .animation(VAnimation.fast, value: isMenuOpen)
        .onTapGesture {
            selectConversation()
            onSelect?()
        }
        .overlay(alignment: .leading) {
            // Pin button rendered as an overlay so it sits above .onTapGesture
            // in the hit-test chain. Without this, .contentShape(Rectangle()) +
            // .onTapGesture on the parent intercepts clicks before they reach
            // child Button views on macOS (same pattern as the trailing
            // "More options" overlay below).
            if isHovered {
                VButton(
                    label: conversation.isPinned ? "Unpin \(conversation.title)" : "Pin \(conversation.title)",
                    iconOnly: conversation.isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                    style: .ghost,
                    iconSize: 20,
                    tooltip: conversation.isPinned ? "Unpin" : "Pin",
                    iconColor: VColor.contentSecondary,
                    iconRotation: conversation.isPinned ? .degrees(0) : .degrees(-45)
                ) {
                    onTogglePin()
                }
                .padding(.leading, VSpacing.xs)
                .transition(.opacity)
            }
        }
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Conversation: \(conversation.title)")
        .accessibilityAction(.default) {
            selectConversation()
        }
        .overlay(alignment: .trailing) {
            if isHovered || isMenuOpen {
                VButton(
                    label: "More options for \(conversation.title)",
                    iconOnly: VIcon.ellipsis.rawValue,
                    style: .ghost,
                    iconSize: 20,
                    tooltip: "More options",
                    iconColor: VColor.contentSecondary
                ) {
                    guard !isMenuOpen else { return }
                    isMenuOpen = true
                    let appearance = NSApp.keyWindow?.effectiveAppearance
                    VMenuPanel.show(
                        at: NSEvent.mouseLocation,
                        sourceAppearance: appearance
                    ) {
                        VMenu(width: 200) {
                            contextMenuContent
                        }
                    } onDismiss: {
                        isMenuOpen = false
                    }
                }
                .padding(.trailing, VSpacing.xs)
            }
        }
        .padding(.horizontal, 0)
        .vContextMenu(width: 200) {
            contextMenuContent
        }
        .pointerCursor { hovering in
            isMouseInside = hovering
        }
        .onChange(of: conversation) { _, _ in
            // Reset menu state when conversation props change within the same view
            // lifecycle (e.g., title update while menu is open).
            if isMenuOpen {
                isMenuOpen = false
            }
        }
        .onDrag {
            guard !conversation.isChannelConversation else {
                return NSItemProvider()
            }
            onDragStart()
            return NSItemProvider(object: conversation.id.uuidString as NSString)
        } preview: {
            HStack(spacing: VSpacing.xs) {
                Color.clear.frame(width: 20, height: 20)
                Text(conversation.title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
            }
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .frame(width: 220, alignment: .leading)
            .background(VColor.surfaceBase.opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }
}
