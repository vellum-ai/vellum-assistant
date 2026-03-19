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
                            .font(VFont.small)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if presentation.canCopy {
                SidebarPrimaryRow(icon: VIcon.copy.rawValue, label: "Copy full conversation", action: onCopy)
            }

            if presentation.showsForkConversationAction {
                SidebarPrimaryRow(icon: VIcon.gitBranch.rawValue, label: "Fork conversation", action: onForkConversation)
            }

            SidebarPrimaryRow(
                icon: presentation.isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                label: presentation.isPinned ? "Unpin" : "Pin",
                action: presentation.isPinned ? onUnpin : onPin
            )

            SidebarPrimaryRow(icon: VIcon.pencil.rawValue, label: "Rename", action: onRename)

            SidebarPrimaryRow(icon: VIcon.archive.rawValue, label: "Archive", action: onArchive)
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
        .frame(width: 200)
        .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .top)))
    }
}
