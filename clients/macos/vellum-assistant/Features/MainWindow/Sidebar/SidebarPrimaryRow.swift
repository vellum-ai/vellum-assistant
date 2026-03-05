import AppKit
import SwiftUI
import VellumAssistantShared

/// Unified sidebar row used by both nav items and pinned apps.
/// Handles expanded (icon + label) and collapsed (icon-only) modes
/// with consistent spacing, backgrounds, and hover behavior.
struct SidebarPrimaryRow: View {
    let icon: String
    let label: String
    var isActive: Bool = false
    var isExpanded: Bool = true
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: isExpanded ? VSpacing.xs : 0) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._400))
                    .frame(width: 20)
                Text(label)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(width: isExpanded ? nil : 0, alignment: .leading)
                    .clipped()
                    .opacity(isExpanded ? 1 : 0)
                    .allowsHitTesting(false)
                if isExpanded {
                    Spacer()
                }
            }
            .padding(.leading, isExpanded ? VSpacing.xs : 0)
            .padding(.trailing, isExpanded ? VSpacing.sm : 0)
            .padding(.vertical, VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: isExpanded ? .leading : .center)
            .background(
                (isActive ? VColor.navActive : isHovered ? VColor.navHover : .clear)
                    .animation(VAnimation.fast, value: isHovered)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, isExpanded ? VSpacing.sm : VSpacing.xs)
        .help(isExpanded ? "" : label)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

/// Convenience alias — existing callsites use `SidebarNavRow`.
typealias SidebarNavRow = SidebarPrimaryRow
