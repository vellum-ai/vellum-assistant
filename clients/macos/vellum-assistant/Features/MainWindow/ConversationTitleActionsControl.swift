import SwiftUI
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

/// Top-left conversation header above the chat: shows conversation title + chevron.
/// Tapping opens a VMenuPanel centered below the title with conversation actions.
struct ConversationTitleActionsControl: View {
    let presentation: ConversationHeaderPresentation
    let onCopy: () -> Void
    let onForkConversation: () -> Void
    let onPin: () -> Void
    let onUnpin: () -> Void
    let onArchive: () -> Void
    let onRename: () -> Void
    let onOpenForkParent: () -> Void
    let onAnalyzeConversation: () -> Void
    var onOpenInNewWindow: (() -> Void)? = nil

    #if os(macOS)
    @State private var isMenuOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero

    /// Fixed width for the conversation actions menu (220–260pt range).
    static let menuWidth: CGFloat = 240
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            VButton(
                label: presentation.displayTitle,
                rightIcon: presentation.showsActionsMenu ? VIcon.chevronDown.rawValue : nil,
                style: .ghost,
                tintColor: VColor.contentDefault
            ) {
                #if os(macOS)
                if presentation.showsActionsMenu {
                    if isMenuOpen {
                        activePanel?.close()
                        activePanel = nil
                        isMenuOpen = false
                    } else {
                        showMenu()
                    }
                }
                #endif
            }
            .lineLimit(1)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, VSpacing.xl)
            #if os(macOS)
            .overlay {
                GeometryReader { geo in
                    Color.clear
                        .onAppear { triggerFrame = geo.frame(in: .global) }
                        .onChange(of: geo.frame(in: .global)) { _, newFrame in
                            triggerFrame = newFrame
                        }
                }
            }
            #endif

            if let parentTitle = presentation.forkParentTitle, presentation.showsForkParentLink {
                Button(action: onOpenForkParent) {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.gitBranch, size: 11)
                        Text("Forked from \(parentTitle)")
                            .font(VFont.labelSmall)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .foregroundStyle(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel("Open parent conversation")
            }
        }
    }

    #if os(macOS)
    private func showMenu() {
        guard !isMenuOpen else { return }
        isMenuOpen = true

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        // Convert the trigger button's bottom-center to screen coordinates.
        // SwiftUI's global coordinate space has y increasing downward;
        // AppKit's screen coordinates have y increasing upward.
        let triggerBottomCenter = CGPoint(
            x: triggerFrame.midX,
            y: triggerFrame.maxY
        )
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerBottomCenter.x,
            y: window.frame.height - triggerBottomCenter.y
        ))

        // Offset the screen point left by half the menu width so the menu
        // is centered beneath the title. VMenuPanel.clampedOrigin will
        // clamp to screen edges if this overflows.
        let centeredScreenPoint = CGPoint(
            x: screenPoint.x - Self.menuWidth / 2 + VMenuPanel.shadowInset,
            y: screenPoint.y
        )

        // Compute trigger rect in screen coordinates so VMenuPanel's
        // click-outside handler can ignore clicks on the trigger button.
        let triggerScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: triggerFrame.minX,
            y: window.frame.height - triggerFrame.maxY
        ))
        let triggerScreenRect = CGRect(
            origin: triggerScreenOrigin,
            size: CGSize(width: triggerFrame.width, height: triggerFrame.height)
        )

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(
            at: centeredScreenPoint,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: triggerScreenRect
        ) {
            ConversationActionsMenuContent(
                presentation: presentation,
                onCopy: onCopy,
                onForkConversation: onForkConversation,
                onPin: onPin,
                onUnpin: onUnpin,
                onArchive: onArchive,
                onRename: onRename,
                onAnalyzeConversation: onAnalyzeConversation,
                onOpenInNewWindow: onOpenInNewWindow
            )
        } onDismiss: {
            isMenuOpen = false
            activePanel = nil
        }
    }
    #endif
}

/// Menu content for the conversation actions dropdown.
struct ConversationActionsMenuContent: View {
    let presentation: ConversationHeaderPresentation
    let onCopy: () -> Void
    let onForkConversation: () -> Void
    let onPin: () -> Void
    let onUnpin: () -> Void
    let onArchive: () -> Void
    let onRename: () -> Void
    let onAnalyzeConversation: () -> Void
    var onOpenInNewWindow: (() -> Void)? = nil

    var body: some View {
        VMenu(width: ConversationTitleActionsControl.menuWidth) {
            if presentation.canCopy {
                VMenuItem(icon: VIcon.copy.rawValue, label: "Copy full conversation", action: onCopy)
            }

            if presentation.showsForkConversationAction && !presentation.isChannelConversation {
                VMenuItem(icon: VIcon.gitBranch.rawValue, label: "Fork conversation", action: onForkConversation)
            }

            if presentation.isPersisted && !presentation.isChannelConversation && !presentation.isPrivateConversation {
                VMenuItem(
                    icon: VIcon.sparkles.rawValue,
                    label: "Analyze conversation",
                    action: onAnalyzeConversation
                )
            }

            if let onOpenInNewWindow {
                VMenuItem(icon: VIcon.externalLink.rawValue, label: "Open in new window", action: onOpenInNewWindow)
            }

            VMenuItem(
                icon: presentation.isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                label: presentation.isPinned ? "Unpin" : "Pin",
                action: presentation.isPinned ? onUnpin : onPin
            )

            VMenuItem(icon: VIcon.pencil.rawValue, label: "Rename", action: onRename)

            if !presentation.isChannelConversation {
                VMenuItem(icon: VIcon.archive.rawValue, label: "Archive", action: onArchive)
            }
        }
    }
}
