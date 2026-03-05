import SwiftUI
import VellumAssistantShared

/// A single thread row in the sidebar, handling hover, pin, archive, rename,
/// and drag interactions.
struct SidebarThreadItem: View {
    let thread: ThreadModel
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var windowState: MainWindowState
    var sidebar: SidebarInteractionState
    /// Called when the user taps the thread row (handles selection logic).
    var selectThread: () -> Void
    /// Optional additional callback after selection (e.g. dismiss a popover).
    var onSelect: (() -> Void)? = nil

    private var isSelected: Bool {
        switch windowState.selection {
        case .panel:
            return false
        case .thread(let id):
            return id == thread.id
        case .appEditing(_, let threadId):
            return threadId == thread.id
        case .app, .none:
            // No explicit thread in selection; fall back to the persistent thread.
            return thread.id == windowState.persistentThreadId
        }
    }

    private var isHovered: Bool { sidebar.isHoveredThread == thread.id }
    private var interactionState: ThreadInteractionState { threadManager.interactionState(for: thread.id) }
    // Reserve trailing space when hovered for archive button overlay.
    private var hasTrailingIcon: Bool { isHovered || sidebar.threadPendingDeletion == thread.id }

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
                                threadManager.unpinThread(id: thread.id)
                            } else {
                                threadManager.pinThread(id: thread.id)
                            }
                        }
                    } label: {
                        Image(systemName: thread.isPinned ? "pin.fill" : "pin")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(thread.isPinned ? VColor.textMuted : VColor.textSecondary)
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
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.warning)
                            .frame(width: 20, height: 20)
                    case .error:
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.error)
                            .frame(width: 20, height: 20)
                            .transition(.opacity)
                    case .idle:
                        if thread.hasUnseenLatestAssistantMessage {
                            Circle()
                                .fill(Color(hex: 0xE86B40))
                                .frame(width: 6, height: 6)
                                .frame(width: 20, height: 20)
                                .transition(.opacity)
                        } else if thread.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(VColor.textMuted)
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
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(VColor.accent.opacity(0.7))
                }
                Text(thread.title)
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(thread.title)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, hasTrailingIcon ? (VSpacing.xs + 20 + VSpacing.xs) : VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .background {
                if isSelected {
                    VColor.navActive
                } else if isHovered {
                    VColor.navHover
                } else if thread.kind == .private {
                    VColor.accent.opacity(0.04)
                } else {
                    Color.clear
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
            .animation(VAnimation.fast, value: isHovered)
        }
        .onTapGesture {
            selectThread()
            onSelect?()
        }
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Thread: \(thread.title)")
        .accessibilityAction(.default) {
            selectThread()
        }
        .overlay(alignment: .trailing) {
            if sidebar.threadPendingDeletion == thread.id {
                VButton(label: "Confirm", style: .danger, size: .small) {
                    threadManager.archiveThread(id: thread.id)
                    sidebar.threadPendingDeletion = nil
                }
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Confirm archive \(thread.title)")
            } else if isHovered {
                Button {
                    sidebar.threadPendingDeletion = thread.id
                } label: {
                    Image(systemName: "archivebox")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, VSpacing.xs)
                .accessibilityLabel("Archive \(thread.title)")
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .contextMenu {
            Button {
                withAnimation(VAnimation.standard) {
                    if thread.isPinned {
                        threadManager.unpinThread(id: thread.id)
                    } else {
                        threadManager.pinThread(id: thread.id)
                    }
                }
            } label: {
                Label(thread.isPinned ? "Unpin" : "Pin to Top", systemImage: thread.isPinned ? "pin.slash" : "pin")
            }
            if thread.sessionId != nil {
                Button {
                    sidebar.renamingThreadId = thread.id
                    sidebar.renameText = thread.title
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
            }
            Button {
                threadManager.archiveThread(id: thread.id)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
        .pointerCursor()
        .onHover { hovering in
            sidebar.setThreadHover(threadId: thread.id, hovering: hovering)
        }
        .onDrag {
            sidebar.draggingThreadId = thread.id
            return NSItemProvider(object: thread.id.uuidString as NSString)
        } preview: {
            HStack(spacing: VSpacing.xs) {
                if thread.isPinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 20, height: 20)
                } else {
                    Color.clear.frame(width: 20, height: 20)
                }
                Text(thread.title)
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
            }
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, VSpacing.sm)
            .frame(width: 220, alignment: .leading)
            .background(VColor.surface.opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }
}

#if DEBUG
#Preview("SidebarThreadItem") {
    let dc = DaemonClient()
    let tm = ThreadManager(daemonClient: dc)
    let ws = MainWindowState()
    let sidebar = SidebarInteractionState()

    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            SidebarThreadItem(
                thread: ThreadModel(title: "Hello world", isPinned: true),
                threadManager: tm,
                windowState: ws,
                sidebar: sidebar,
                selectThread: {}
            )
            SidebarThreadItem(
                thread: ThreadModel(title: "Draft email to team"),
                threadManager: tm,
                windowState: ws,
                sidebar: sidebar,
                selectThread: {}
            )
            SidebarThreadItem(
                thread: ThreadModel(title: "Private thread", kind: .private),
                threadManager: tm,
                windowState: ws,
                sidebar: sidebar,
                selectThread: {}
            )
        }
    }
    .frame(width: 240, height: 150)
}
#endif
