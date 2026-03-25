import SwiftUI
import VellumAssistantShared

/// A single conversation row in the sidebar, handling hover, pin, archive, rename,
/// and drag interactions.
///
/// This is a pure value view — all state is pre-resolved into value-type props
/// and action closures, so SwiftUI can skip re-evaluation via `Equatable`.
struct SidebarConversationItem: View, Equatable {
    let conversation: ConversationModel
    let isSelected: Bool
    let interactionState: ConversationInteractionState
    let isHovered: Bool
    let isPendingDeletion: Bool

    // Action closures — not compared in Equatable
    var selectConversation: () -> Void
    var onSelect: (() -> Void)? = nil
    var onTogglePin: () -> Void
    var onArchive: () -> Void
    var onBeginArchive: () -> Void
    var onConfirmArchive: () -> Void
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
        lhs.isHovered == rhs.isHovered &&
        lhs.isPendingDeletion == rhs.isPendingDeletion
    }

    private var hasTrailingIcon: Bool { isHovered || isPendingDeletion }
    private var canMarkUnread: Bool {
        !conversation.hasUnseenLatestAssistantMessage &&
            conversation.conversationId != nil &&
            conversation.latestAssistantMessageAt != nil
    }

    var body: some View {
        // Always reserve 20pt leading slot so text never shifts.
        // Use a tap gesture instead of Button so .onDrag can coexist —
        // Button captures mouse-down and prevents drag initiation on macOS.
        Group {
            HStack(spacing: VSpacing.xs) {
                // Leading 20x20 slot: single render path.
                // Hovered -> interactive pin button; not hovered -> status indicator.
                if isHovered {
                    Button {
                        onTogglePin()
                    } label: {
                        VIconView(.pin, size: 13)
                            .foregroundStyle(conversation.isPinned ? VColor.contentTertiary : VColor.contentSecondary)
                            .rotationEffect(.degrees(-45))
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity)
                    .nativeTooltip(conversation.isPinned ? "Unpin" : "Pin")
                    .accessibilityLabel(conversation.isPinned ? "Unpin \(conversation.title)" : "Pin \(conversation.title)")
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
                    .font(.system(size: 13))
                    .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .nativeTooltip(conversation.title)

            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, isPendingDeletion ? SidebarLayoutMetrics.archiveConfirmTrailingPadding : hasTrailingIcon ? SidebarLayoutMetrics.archiveIconTrailingPadding : VSpacing.sm)
            .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
            .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
            .background {
                if isSelected {
                    VColor.surfaceActive
                } else if isHovered {
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
        }
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
            if isPendingDeletion {
                VButton(label: "Confirm", style: .dangerOutline, size: .pill) {
                    onConfirmArchive()
                }
                .fixedSize()
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Confirm archive \(conversation.title)")
            } else if isHovered {
                Button {
                    onBeginArchive()
                } label: {
                    VIconView(.archive, size: 13)
                        .foregroundStyle(VColor.contentSecondary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .nativeTooltip("Archive")
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Archive \(conversation.title)")
            }
        }
        .padding(.horizontal, 0)
        .contextMenu {
            Button {
                onTogglePin()
            } label: {
                Label { Text(conversation.isPinned ? "Unpin" : "Pin") } icon: { VIconView(conversation.isPinned ? .pinOff : .pin, size: 14) }
            }
            Button {
                onStartRename()
            } label: {
                Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
            }
            Button {
                onArchive()
            } label: {
                Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
            }
            Button {
                onMarkUnread()
            } label: {
                Label { Text("Mark as unread") } icon: { VIconView(.circle, size: 14) }
            }
            .disabled(!canMarkUnread)

            if let onOpenInNewWindow {
                Button {
                    onOpenInNewWindow()
                } label: {
                    Label { Text("Open in New Window") } icon: { VIconView(.externalLink, size: 14) }
                }
            }

            Divider()

            Button {
                onShowFeedback?()
            } label: {
                Label { Text("Share Feedback") } icon: { VIconView(.messageCircle, size: 14) }
            }
            .disabled(onShowFeedback == nil)
        }
        .pointerCursor { hovering in
            onHoverChange(hovering)
        }
        .onDrag {
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
                    .font(.system(size: 13))
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
