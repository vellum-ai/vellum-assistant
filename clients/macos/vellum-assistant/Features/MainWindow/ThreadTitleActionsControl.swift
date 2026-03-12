import SwiftUI
import VellumAssistantShared

/// Top-left thread header above the chat: shows thread title + chevron.
/// Tapping opens a drawer-style popover with thread actions.
struct ThreadTitleActionsControl: View {
    let presentation: ThreadHeaderPresentation
    let onCopy: () -> Void
    let onPin: () -> Void
    let onUnpin: () -> Void
    let onArchive: () -> Void
    let onRename: () -> Void
    @Binding var showDrawer: Bool

    var body: some View {
        Button {
            if presentation.showsActionsMenu {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                    showDrawer.toggle()
                }
            }
        } label: {
            HStack(spacing: VSpacing.xs) {
                Text(presentation.displayTitle)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
                if presentation.showsActionsMenu {
                    VIconView(.chevronDown, size: 9)
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(showDrawer ? -180 : 0))
                        .animation(VAnimation.fast, value: showDrawer)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
    }
}

/// Drawer-style popover for thread actions, matching the preferences drawer pattern.
struct ThreadActionsDrawer: View {
    let presentation: ThreadHeaderPresentation
    let onCopy: () -> Void
    let onPin: () -> Void
    let onUnpin: () -> Void
    let onArchive: () -> Void
    let onRename: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if presentation.canCopy {
                SidebarPrimaryRow(icon: VIcon.copy.rawValue, label: "Copy full thread", action: onCopy)
            }

            SidebarPrimaryRow(
                icon: presentation.isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                label: presentation.isPinned ? "Unpin" : "Pin",
                action: presentation.isPinned ? onUnpin : onPin
            )

            SidebarPrimaryRow(icon: VIcon.pencil.rawValue, label: "Rename thread", action: onRename)

            SidebarPrimaryRow(icon: VIcon.archive.rawValue, label: "Archive thread", action: onArchive)
        }
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .shadow(color: VColor.auxBlack.opacity(0.15), radius: 6, y: 2)
        .frame(width: 200)
        .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .top)))
    }
}
