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

    @State private var contextMenuPanel: VMenuPanel?

    private var hasTrailingIcon: Bool { isHovered || isPendingDeletion }
    private var canMarkUnread: Bool {
        !conversation.hasUnseenLatestAssistantMessage &&
            conversation.conversationId != nil &&
            conversation.latestAssistantMessageAt != nil
    }

    private var contextMenuContent: some View {
        VMenu(width: 200) {
            VMenuItem(icon: VIcon.pin.rawValue, label: conversation.isPinned ? "Unpin" : "Pin") {
                contextMenuPanel?.close()
                onTogglePin()
            }
            VMenuItem(icon: VIcon.pencil.rawValue, label: "Rename") {
                contextMenuPanel?.close()
                onStartRename()
            }
            VMenuItem(icon: VIcon.archive.rawValue, label: "Archive") {
                contextMenuPanel?.close()
                onArchive()
            }
            VMenuItem(icon: VIcon.circle.rawValue, label: "Mark as unread") {
                contextMenuPanel?.close()
                onMarkUnread()
            }
            .opacity(canMarkUnread ? 1 : 0.4)
            .disabled(!canMarkUnread)

            if let onOpenInNewWindow {
                VMenuItem(icon: VIcon.externalLink.rawValue, label: "Open in New Window") {
                    contextMenuPanel?.close()
                    onOpenInNewWindow()
                }
            }

            VMenuDivider()

            VMenuItem(icon: VIcon.messageCircle.rawValue, label: "Share Feedback") {
                contextMenuPanel?.close()
                onShowFeedback?()
            }
            .opacity(onShowFeedback != nil ? 1 : 0.4)
            .disabled(onShowFeedback == nil)
        }
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
        .onRightClick { screenPoint in
            contextMenuPanel?.close()
            contextMenuPanel = VMenuPanel.show(at: screenPoint) {
                contextMenuContent
            } onDismiss: {
                contextMenuPanel = nil
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

// MARK: - Right-click detection (local prototype only)

private struct RightClickView: NSViewRepresentable {
    /// Called with the click location in screen coordinates.
    let action: (CGPoint) -> Void

    func makeNSView(context: Context) -> RightClickNSView {
        RightClickNSView(action: action)
    }

    func updateNSView(_ nsView: RightClickNSView, context: Context) {
        nsView.action = action
    }

    class RightClickNSView: NSView {
        var action: (CGPoint) -> Void
        private var monitor: Any?

        init(action: @escaping (CGPoint) -> Void) {
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
                    let screenPoint = window.convertPoint(toScreen: event.locationInWindow)
                    // Tag the screen point with the source window's appearance
                    VMenuPanel.sourceAppearance = window.effectiveAppearance
                    self.action(screenPoint)
                    return nil
                }
                return event
            }
        }

        override func removeFromSuperview() {
            monitor.flatMap(NSEvent.removeMonitor)
            monitor = nil
            super.removeFromSuperview()
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

private extension View {
    func onRightClick(perform action: @escaping (CGPoint) -> Void) -> some View {
        background {
            RightClickView(action: action)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - VMenuPanel (floating window for context menus)

/// A borderless, floating NSPanel that hosts a VMenu at a given screen position.
/// Dismisses automatically when the user clicks outside or presses Escape.
private class VMenuPanel: NSPanel {
    private var dismissHandler: (() -> Void)?
    private var clickMonitor: Any?

    /// Set by RightClickNSView before invoking the action so the panel inherits
    /// the source window's appearance (light/dark) for correct VColor resolution.
    static var sourceAppearance: NSAppearance?

    /// Show a VMenu at the given screen coordinates. Returns the panel for later dismissal.
    static func show<Content: View>(
        at screenPoint: CGPoint,
        @ViewBuilder content: () -> Content,
        onDismiss: @escaping () -> Void
    ) -> VMenuPanel {
        let panel = VMenuPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.level = .popUpMenu
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false // VMenu provides its own shadow
        panel.dismissHandler = onDismiss

        // Inherit the source window's appearance so VColor tokens resolve correctly
        if let appearance = sourceAppearance {
            panel.appearance = appearance
        }
        sourceAppearance = nil

        let hostingView = NSHostingView(rootView: content())
        hostingView.sizingOptions = [.intrinsicContentSize]

        // Wrap in a container that accepts first-mouse so clicks work immediately
        // without needing to activate the panel first.
        let container = FirstMouseView()
        container.wantsLayer = true
        container.layer?.cornerRadius = 12 // VRadius.lg
        container.layer?.masksToBounds = true

        hostingView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.topAnchor.constraint(equalTo: container.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            hostingView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        panel.contentView = container

        // Size to fit content
        let intrinsicSize = hostingView.intrinsicContentSize
        let menuSize = CGSize(
            width: max(intrinsicSize.width, 200),
            height: intrinsicSize.height
        )

        // Position: top-left of menu at cursor, menu grows downward.
        // In AppKit screen coords, Y=0 is bottom, so subtract height.
        let origin = CGPoint(x: screenPoint.x, y: screenPoint.y - menuSize.height)
        panel.setFrame(CGRect(origin: origin, size: menuSize), display: true)
        panel.makeKeyAndOrderFront(nil)

        // Install click-outside monitor (one-shot, async to skip the opening right-click)
        DispatchQueue.main.async {
            panel.clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
                // If the click is inside the panel, let it through (menu item tap)
                let locationInPanel = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
                let panelBounds = panel.contentView?.bounds ?? .zero
                if panelBounds.contains(locationInPanel) {
                    return event
                }
                // Click outside — dismiss
                panel.close()
                return event
            }
        }

        return panel
    }

    override func close() {
        clickMonitor.flatMap(NSEvent.removeMonitor)
        clickMonitor = nil
        dismissHandler?()
        dismissHandler = nil
        super.close()
    }

    override func cancelOperation(_ sender: Any?) {
        close() // Escape key dismisses
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Container view that accepts first-mouse clicks so taps work immediately
/// in a non-activating panel without requiring a focus click first.
private class FirstMouseView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // Propagate first-mouse to all subviews (including NSHostingView internals)
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit
    }
}
