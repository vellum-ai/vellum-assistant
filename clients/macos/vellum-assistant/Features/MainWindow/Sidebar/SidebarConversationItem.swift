import SwiftUI
import VellumAssistantShared

/// A single conversation row in the sidebar, handling hover, pin, archive, rename,
/// and drag interactions.
///
/// Value-type props and action closures are compared via `Equatable` so SwiftUI
/// can skip re-evaluation when parent views re-render for unrelated reasons.
///
/// Hover state (`isHovered`) is observed directly from `SidebarInteractionState`
/// inside this view's `body`, keeping the `@Observable` dependency scoped here
/// rather than in the parent. This prevents sidebar hover from invalidating
/// unrelated views (e.g. the chat panel) that share a common ancestor.
///
/// - SeeAlso: [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
struct SidebarConversationItem: View, Equatable {
    let conversation: ConversationModel
    let isSelected: Bool
    let interactionState: ConversationInteractionState
    /// Provides hover state via `@Observable` property-level tracking.
    /// The observation dependency is established in this view's `body`,
    /// not in the parent, so hover changes only invalidate this row.
    var sidebarInteraction: SidebarInteractionState

    // Action closures — not compared in Equatable
    var selectConversation: () -> Void
    var onSelect: (() -> Void)? = nil
    var onTogglePin: () -> Void
    var onArchive: () -> Void
    var onStartRename: () -> Void
    var onMarkUnread: () -> Void
    var onHoverChange: (Bool) -> Void
    var onDragStart: () -> Void
    var onOpenInNewWindow: (() -> Void)?
    var onShowFeedback: (() -> Void)?

    static func == (lhs: SidebarConversationItem, rhs: SidebarConversationItem) -> Bool {
        lhs.conversation == rhs.conversation &&
        lhs.isSelected == rhs.isSelected &&
        lhs.interactionState == rhs.interactionState &&
        lhs.sidebarInteraction === rhs.sidebarInteraction
    }

    @State private var isMenuOpen: Bool = false
    private var isHovered: Bool { sidebarInteraction.isHoveredConversation == conversation.id }
    private var hasTrailingIcon: Bool { isHovered || isMenuOpen }
    private var canMarkUnread: Bool {
        !conversation.hasUnseenLatestAssistantMessage &&
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
            // Leading 20x20 slot: single render path.
            // Hovered -> interactive pin button; not hovered -> status indicator.
            if isHovered {
                VButton(
                    label: conversation.isPinned ? "Unpin \(conversation.title)" : "Pin \(conversation.title)",
                    iconOnly: VIcon.pin.rawValue,
                    style: .ghost,
                    iconSize: 20,
                    tooltip: conversation.isPinned ? "Unpin" : "Pin",
                    iconColor: conversation.isPinned ? VColor.contentTertiary : VColor.contentSecondary,
                    iconRotation: .degrees(-45)
                ) {
                    onTogglePin()
                }
                .transition(.opacity)
            } else {
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
                    } else if conversation.isPinned {
                        VIconView(.pin, size: 13)
                            .foregroundStyle(VColor.contentTertiary)
                            .rotationEffect(.degrees(-45))
                            .frame(width: 20, height: 20)
                            .nativeTooltip("Pinned")
                            .accessibilityLabel("Pinned")
                            .transition(.opacity)
                    } else {
                        Color.clear
                            .frame(width: 20, height: 20)
                    }
                }
            }
            if conversation.kind == .private {
                VIconView(.lock, size: 13)
                    .foregroundStyle(VColor.primaryBase.opacity(0.7))
                    .nativeTooltip("Private conversation")
                    .accessibilityLabel("Private conversation")
            }
            Text(conversation.title)
                .font(VFont.menuCompact)
                .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .nativeTooltip(conversation.title)

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
        .animation(VAnimation.fast, value: isHovered)
        .animation(VAnimation.fast, value: isMenuOpen)
        .onTapGesture {
            selectConversation()
            onSelect?()
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
            onHoverChange(hovering)
        }
        .onDrag {
            guard !conversation.isChannelConversation else {
                return NSItemProvider()
            }
            onDragStart()
            return NSItemProvider(object: conversation.id.uuidString as NSString)
        } preview: {
            HStack(spacing: VSpacing.xs) {
                if conversation.isPinned {
                    VIconView(.pin, size: 13)
                        .foregroundStyle(VColor.contentTertiary)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 20, height: 20)
                } else {
                    Color.clear.frame(width: 20, height: 20)
                }
                Text(conversation.title)
                    .font(VFont.menuCompact)
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

