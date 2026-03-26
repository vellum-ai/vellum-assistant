import SwiftUI
import VellumAssistantShared

/// Top-left conversation header above the chat: shows conversation title + chevron.
/// Tapping opens a drawer-style popover with conversation actions.
struct ConversationTitleActionsControl: View {
    let presentation: ConversationHeaderPresentation
    let onCopy: () -> Void
    let onForkConversation: () -> Void
    let onPin: () -> Void
    let onUnpin: () -> Void
    let onArchive: () -> Void
    let onRename: () -> Void
    let onOpenForkParent: () -> Void
    @Binding var showDrawer: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            VButton(
                label: presentation.displayTitle,
                rightIcon: presentation.showsActionsMenu ? VIcon.chevronDown.rawValue : nil,
                style: .ghost
            ) {
                if presentation.showsActionsMenu {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                        showDrawer.toggle()
                    }
                }
            }

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
}

/// Drawer-style popover for conversation actions, matching the preferences drawer pattern.
struct ConversationActionsDrawer: View {
    let presentation: ConversationHeaderPresentation
    let onCopy: () -> Void
    let onForkConversation: () -> Void
    let onPin: () -> Void
    let onUnpin: () -> Void
    let onArchive: () -> Void
    let onRename: () -> Void
    var onOpenInNewWindow: (() -> Void)? = nil

    var body: some View {
        VMenu(width: 200) {
            if presentation.canCopy {
                VMenuItem(icon: VIcon.copy.rawValue, label: "Copy full conversation", action: onCopy)
            }

            if presentation.showsForkConversationAction {
                VMenuItem(icon: VIcon.gitBranch.rawValue, label: "Fork conversation", action: onForkConversation)
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

            VMenuItem(icon: VIcon.archive.rawValue, label: "Archive", action: onArchive)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .top)))
    }
}
