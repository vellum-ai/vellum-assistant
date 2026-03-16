import SwiftUI
import VellumAssistantShared

/// A single thread row in the sidebar, handling hover, pin, archive, rename,
/// and drag interactions.
struct SidebarThreadItem: View {
    let thread: ConversationModel
    @ObservedObject var conversationManager: ConversationManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    /// Called when the user taps the thread row (handles selection logic).
    var selectConversation: () -> Void
    /// Optional additional callback after selection (e.g. dismiss a popover).
    var onSelect: (() -> Void)? = nil

    private var isSelected: Bool {
        switch windowState.selection {
        case .panel:
            return false
        case .conversation(let id):
            return id == thread.id
        case .appEditing(_, let conversationId):
            return conversationId == thread.id
        case .app, .none:
            // No explicit conversation in selection; fall back to the persistent conversation.
            return thread.id == windowState.persistentConversationId
        }
    }

    private var isHovered: Bool { sidebar.isHoveredThread == thread.id }
    private var interactionState: ConversationInteractionState { conversationManager.interactionState(for: thread.id) }
    // Reserve trailing space when hovered for archive button overlay.
    private var hasTrailingIcon: Bool { isHovered || sidebar.threadPendingDeletion == thread.id }
    private var isPendingDeletion: Bool { sidebar.threadPendingDeletion == thread.id }
    private var canMarkUnread: Bool {
        !thread.hasUnseenLatestAssistantMessage &&
            thread.conversationId != nil &&
            thread.latestAssistantMessageAt != nil
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
                            if thread.isPinned {
                                conversationManager.unpinThread(id: thread.id)
                            } else {
                                conversationManager.pinThread(id: thread.id)
                            }
                        }
                    } label: {
                        VIconView(.pin, size: 13)
                            .foregroundColor(thread.isPinned ? VColor.contentTertiary : VColor.contentSecondary)
                            .rotationEffect(.degrees(-45))
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity)
                    .accessibilityLabel(thread.isPinned ? "Unpin \(thread.title)" : "Pin \(thread.title)")
                } else {
                    switch interactionState {
                    case .processing:
                        VBusyIndicator()
                            .frame(width: 20, height: 20)
                    case .waitingForInput:
                        VIconView(.circleAlert, size: 12)
                            .foregroundColor(VColor.systemNegativeHover)
                            .frame(width: 20, height: 20)
                    case .error:
                        VIconView(.circleAlert, size: 12)
                            .foregroundColor(VColor.systemNegativeStrong)
                            .frame(width: 20, height: 20)
                            .transition(.opacity)
                    case .idle:
                        if thread.hasUnseenLatestAssistantMessage {
                            VBadge(style: .dot, color: VColor.systemNegativeHover)
                                .accessibilityLabel("Unread")
                                .frame(width: 20, height: 20)
                                .transition(.opacity)
                        } else if thread.isPinned {
                            VIconView(.pin, size: 13)
                                .foregroundColor(VColor.contentTertiary)
                                .rotationEffect(.degrees(-45))
                                .frame(width: 20, height: 20)
                                .transition(.opacity)
                        } else {
                            Color.clear
                                .frame(width: 20, height: 20)
                        }
                    }
                }
                if thread.kind == .private {
                    VIconView(.lock, size: 13)
                        .foregroundColor(VColor.primaryBase.opacity(0.7))
                }
                Text(thread.title)
                    .font(.system(size: 13))
                    .foregroundColor(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(thread.title)

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
                } else if thread.kind == .private {
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
        .accessibilityLabel("Conversation: \(thread.title)")
        .accessibilityAction(.default) {
            selectConversation()
        }
        .overlay(alignment: .trailing) {
            if sidebar.threadPendingDeletion == thread.id {
                VButton(label: "Confirm", style: .dangerOutline, size: .pill) {
                    conversationManager.archiveConversation(id: thread.id)
                    sidebar.threadPendingDeletion = nil
                }
                .fixedSize()
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Confirm archive \(thread.title)")
            } else if isHovered {
                Button {
                    sidebar.threadPendingDeletion = thread.id
                } label: {
                    VIconView(.archive, size: 13)
                        .foregroundColor(VColor.contentSecondary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Archive \(thread.title)")
            }
        }
        .padding(.horizontal, 0)
        .contextMenu {
            Button {
                withAnimation(VAnimation.standard) {
                    if thread.isPinned {
                        conversationManager.unpinThread(id: thread.id)
                    } else {
                        conversationManager.pinThread(id: thread.id)
                    }
                }
            } label: {
                Label { Text(thread.isPinned ? "Unpin thread" : "Pin thread") } icon: { VIconView(thread.isPinned ? .pinOff : .pin, size: 14) }
            }
            Button {
                sidebar.renamingThreadId = thread.id
                sidebar.renameText = thread.title
            } label: {
                Label { Text("Rename thread") } icon: { VIconView(.pencil, size: 14) }
            }
            Button {
                conversationManager.archiveConversation(id: thread.id)
            } label: {
                Label { Text("Archive thread") } icon: { VIconView(.archive, size: 14) }
            }
            Button {
                conversationManager.markConversationUnread(threadId: thread.id)
            } label: {
                Label { Text("Mark as unread") } icon: { VIconView(.circle, size: 14) }
            }
            .disabled(!canMarkUnread)

            Divider()

            Button {
                guard let conversationId = thread.conversationId else { return }
                AppDelegate.shared?.showLogReportWindow(scope: .conversation(conversationId: conversationId, conversationTitle: thread.title))
            } label: {
                Label { Text("Send Logs for Conversation") } icon: { VIconView(.upload, size: 14) }
            }
            .disabled(thread.conversationId == nil || LogExporter.isManagedAssistant)
        }
        .pointerCursor()
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                sidebar.setThreadHover(threadId: thread.id, hovering: hovering)
            }
        }
        .onDrag {
            sidebar.draggingThreadId = thread.id
            return NSItemProvider(object: thread.id.uuidString as NSString)
        } preview: {
            HStack(spacing: VSpacing.xs) {
                if thread.isPinned {
                    VIconView(.pin, size: 13)
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 20, height: 20)
                } else {
                    Color.clear.frame(width: 20, height: 20)
                }
                Text(thread.title)
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
