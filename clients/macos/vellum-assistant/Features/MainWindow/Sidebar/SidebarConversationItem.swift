import SwiftUI
import VellumAssistantShared

/// A single conversation row in the sidebar, handling hover, pin, archive, rename,
/// and drag interactions.
struct SidebarConversationItem: View {
    let conversation: ConversationModel
    @ObservedObject var conversationManager: ConversationManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    /// Called when the user taps the conversation row (handles selection logic).
    var selectConversation: () -> Void
    /// Optional additional callback after selection (e.g. dismiss a popover).
    var onSelect: (() -> Void)? = nil

    private var isSelected: Bool {
        switch windowState.selection {
        case .panel:
            return false
        case .conversation(let id):
            return id == conversation.id
        case .appEditing(_, let conversationId):
            return conversationId == conversation.id
        case .app, .none:
            // No explicit conversation in selection; fall back to the persistent conversation.
            return conversation.id == windowState.persistentConversationId
        }
    }

    private var isHovered: Bool { sidebar.isHoveredConversation == conversation.id }
    private var interactionState: ConversationInteractionState { conversationManager.interactionState(for: conversation.id) }
    // Reserve trailing space when hovered for archive button overlay.
    private var hasTrailingIcon: Bool { isHovered || sidebar.conversationPendingDeletion == conversation.id }
    private var isPendingDeletion: Bool { sidebar.conversationPendingDeletion == conversation.id }
    private var canMarkUnread: Bool {
        !conversation.hasUnseenLatestAssistantMessage &&
            conversation.conversationId != nil &&
            conversation.latestAssistantMessageAt != nil
    }

    var body: some View {
        // Always reserve 20pt leading slot so text never shifts.
        // Use a tap gesture instead of Button so .draggable() can coexist —
        // Button captures mouse-down and prevents drag initiation on macOS.
        Group {
            HStack(spacing: VSpacing.xs) {
                // Leading 20x20 slot: single render path.
                // Hovered -> interactive pin button; not hovered -> status indicator.
                if isHovered {
                    Button {
                        withAnimation(VAnimation.standard) {
                            if conversation.isPinned {
                                conversationManager.unpinConversation(id: conversation.id)
                            } else {
                                conversationManager.pinConversation(id: conversation.id)
                            }
                        }
                    } label: {
                        VIconView(.pin, size: 13)
                            .foregroundColor(conversation.isPinned ? VColor.contentTertiary : VColor.contentSecondary)
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
                            .foregroundColor(VColor.systemNegativeHover)
                            .frame(width: 20, height: 20)
                            .nativeTooltip("Waiting for input")
                            .accessibilityLabel("Waiting for input")
                    case .error:
                        VIconView(.circleAlert, size: 12)
                            .foregroundColor(VColor.systemNegativeStrong)
                            .frame(width: 20, height: 20)
                            .nativeTooltip("Error")
                            .accessibilityLabel("Error")
                            .transition(.opacity)
                    case .idle:
                        if conversation.hasUnseenLatestAssistantMessage {
                            VBadge(style: .dot, color: VColor.systemNegativeHover)
                                .accessibilityLabel("Unread")
                                .frame(width: 20, height: 20)
                                .nativeTooltip("Unread")
                                .transition(.opacity)
                        } else if conversation.isPinned {
                            VIconView(.pin, size: 13)
                                .foregroundColor(VColor.contentTertiary)
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
                        .foregroundColor(VColor.primaryBase.opacity(0.7))
                        .nativeTooltip("Private conversation")
                        .accessibilityLabel("Private conversation")
                }
                Text(conversation.title)
                    .font(.system(size: 13))
                    .foregroundColor(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
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
            if sidebar.conversationPendingDeletion == conversation.id {
                VButton(label: "Confirm", style: .dangerOutline, size: .pill) {
                    conversationManager.archiveConversation(id: conversation.id)
                    sidebar.conversationPendingDeletion = nil
                }
                .fixedSize()
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Confirm archive \(conversation.title)")
            } else if isHovered {
                Button {
                    sidebar.conversationPendingDeletion = conversation.id
                } label: {
                    VIconView(.archive, size: 13)
                        .foregroundColor(VColor.contentSecondary)
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
                withAnimation(VAnimation.standard) {
                    if conversation.isPinned {
                        conversationManager.unpinConversation(id: conversation.id)
                    } else {
                        conversationManager.pinConversation(id: conversation.id)
                    }
                }
            } label: {
                Label { Text(conversation.isPinned ? "Unpin" : "Pin") } icon: { VIconView(conversation.isPinned ? .pinOff : .pin, size: 14) }
            }
            Button {
                sidebar.renamingConversationId = conversation.id
                sidebar.renameText = conversation.title
            } label: {
                Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
            }
            Button {
                conversationManager.archiveConversation(id: conversation.id)
            } label: {
                Label { Text("Archive") } icon: { VIconView(.archive, size: 14) }
            }
            Button {
                conversationManager.markConversationUnread(conversationId: conversation.id)
            } label: {
                Label { Text("Mark as unread") } icon: { VIconView(.circle, size: 14) }
            }
            .disabled(!canMarkUnread)

            Divider()

            Button {
                guard let conversationId = conversation.conversationId else { return }
                AppDelegate.shared?.showLogReportWindow(scope: .conversation(conversationId: conversationId, conversationTitle: conversation.title))
            } label: {
                Label { Text("Send Logs") } icon: { VIconView(.upload, size: 14) }
            }
            .disabled(conversation.conversationId == nil || LogExporter.isManagedAssistant)
        }
        .pointerCursor()
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                sidebar.setConversationHover(conversationId: conversation.id, hovering: hovering)
            }
        }
        .onDrag {
            sidebar.draggingConversationId = conversation.id
            return NSItemProvider(object: conversation.id.uuidString as NSString)
        } preview: {
            HStack(spacing: VSpacing.xs) {
                if conversation.isPinned {
                    VIconView(.pin, size: 13)
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 20, height: 20)
                } else {
                    Color.clear.frame(width: 20, height: 20)
                }
                Text(conversation.title)
                    .font(.system(size: 13))
                    .foregroundColor(VColor.contentDefault)
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

#if DEBUG
#endif
