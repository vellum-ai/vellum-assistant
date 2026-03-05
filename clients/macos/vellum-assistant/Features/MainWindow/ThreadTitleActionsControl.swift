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
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                if presentation.showsActionsMenu {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                        .rotationEffect(.degrees(showDrawer ? -180 : 0))
                        .animation(VAnimation.fast, value: showDrawer)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, VSpacing.lg)
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
                DrawerMenuItem(icon: "doc.on.doc", label: "Copy full thread", action: onCopy)

                VColor.surfaceBorder.frame(height: 1)
                    .padding(.vertical, VSpacing.xs)
            }

            DrawerMenuItem(
                icon: presentation.isPinned ? "pin.slash" : "pin",
                label: presentation.isPinned ? "Unpin" : "Pin",
                action: presentation.isPinned ? onUnpin : onPin
            )

            DrawerMenuItem(icon: "pencil", label: "Rename thread", action: onRename)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            DrawerMenuItem(icon: "archivebox", label: "Archive thread", action: onArchive)
        }
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        .frame(width: 200)
        .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .topLeading)))
    }
}
