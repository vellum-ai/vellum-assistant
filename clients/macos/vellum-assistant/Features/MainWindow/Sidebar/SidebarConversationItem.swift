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

    @State private var showContextMenu = false

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
        .onRightClick { showContextMenu = true }
        .popover(isPresented: $showContextMenu, arrowEdge: .trailing) {
            VMenu(width: 200) {
                VMenuItem(icon: VIcon.pin.rawValue, label: conversation.isPinned ? "Unpin" : "Pin") {
                    showContextMenu = false
                    onTogglePin()
                }
                VMenuItem(icon: VIcon.pencil.rawValue, label: "Rename") {
                    showContextMenu = false
                    onStartRename()
                }
                VMenuItem(icon: VIcon.archive.rawValue, label: "Archive") {
                    showContextMenu = false
                    onArchive()
                }
                VMenuItem(icon: VIcon.circle.rawValue, label: "Mark as unread") {
                    showContextMenu = false
                    onMarkUnread()
                }
                .opacity(canMarkUnread ? 1 : 0.4)
                .disabled(!canMarkUnread)

                if let onOpenInNewWindow {
                    VMenuItem(icon: VIcon.externalLink.rawValue, label: "Open in New Window") {
                        showContextMenu = false
                        onOpenInNewWindow()
                    }
                }

                VMenuDivider()

                VMenuItem(icon: VIcon.messageCircle.rawValue, label: "Share Feedback") {
                    showContextMenu = false
                    onShowFeedback?()
                }
                .opacity(onShowFeedback != nil ? 1 : 0.4)
                .disabled(onShowFeedback == nil)
            }
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

// MARK: - Right-click detection (local prototype only)

private struct RightClickView: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> RightClickNSView {
        RightClickNSView(action: action)
    }

    func updateNSView(_ nsView: RightClickNSView, context: Context) {
        nsView.action = action
    }

    class RightClickNSView: NSView {
        var action: () -> Void
        private var monitor: Any?

        init(action: @escaping () -> Void) {
            self.action = action
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError() }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            monitor.flatMap(NSEvent.removeMonitor)
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
                guard let self, let window = self.window else { return event }
                let locationInView = self.convert(event.locationInWindow, from: nil)
                if self.bounds.contains(locationInView) {
                    self.action()
                    return nil // consume the right-click
                }
                return event // pass through if not in our bounds
            }
        }

        override func removeFromSuperview() {
            monitor.flatMap(NSEvent.removeMonitor)
            monitor = nil
            super.removeFromSuperview()
        }

        // Return nil from hitTest so this view never intercepts left clicks,
        // hover, drag, or any other mouse events from reaching SwiftUI content.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

private extension View {
    func onRightClick(perform action: @escaping () -> Void) -> some View {
        background {
            RightClickView(action: action)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
