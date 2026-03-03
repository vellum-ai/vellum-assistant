import SwiftUI
import VellumAssistantShared

/// A search bar button in the sidebar that opens the command palette.
/// In expanded mode, it looks like a search input field with a shortcut hint.
/// In collapsed mode, it shows only a magnifying glass icon.
struct SidebarSearchButton: View {
    var isExpanded: Bool = true
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            if isExpanded {
                expandedContent
            } else {
                collapsedContent
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, isExpanded ? VSpacing.sm : VSpacing.xs)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    private var expandedContent: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(VColor.textMuted)
                .font(.system(size: 12, weight: .medium))

            Text("Search...")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .lineLimit(1)

            Spacer()

            Text("\u{2318}K")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .padding(.horizontal, VSpacing.xs)
                .padding(.vertical, VSpacing.xxs)
                .background(VColor.surfaceBorder.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
        .background(
            (isHovered ? VColor.surfaceBorder.opacity(0.5) : VColor.surfaceBorder.opacity(0.25))
                .animation(VAnimation.fast, value: isHovered)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private var collapsedContent: some View {
        Image(systemName: "magnifyingglass")
            .foregroundColor(VColor.textMuted)
            .font(.system(size: 13, weight: .medium))
            .frame(width: 20)
            .padding(.vertical, VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .center)
            .background(
                (isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear)
                    .animation(VAnimation.fast, value: isHovered)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .help("Search (\u{2318}K)")
    }
}
