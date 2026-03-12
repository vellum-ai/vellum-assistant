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
    var trailingIcon: String? = nil
    var isExpanded: Bool = true
    let action: () -> Void
    @State private var isHovered = false

    private var iconColor: Color {
        isActive ? VColor.primaryActive : VColor.primaryBase
    }

    private var textColor: Color {
        isActive ? VColor.contentEmphasized : VColor.contentSecondary
    }

    var body: some View {
        HStack(spacing: isExpanded ? VSpacing.xs : 0) {
            VIconView(.resolve(icon), size: 13)
                .foregroundColor(iconColor)
                .frame(width: SidebarLayoutMetrics.iconSlotSize, height: SidebarLayoutMetrics.iconSlotSize)
            Text(label)
                .font(VFont.body)
                .foregroundColor(textColor)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: isExpanded ? nil : 0, alignment: .leading)
                .clipped()
                .opacity(isExpanded ? 1 : 0)
                .allowsHitTesting(false)
            if isExpanded {
                Spacer()
                if let trailingIcon {
                    VIconView(.resolve(trailingIcon), size: 10)
                        .foregroundColor(iconColor)
                }
            }
        }
        .padding(.leading, isExpanded ? VSpacing.xs : 0)
        .padding(.trailing, isExpanded ? VSpacing.sm : 0)
        .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
        .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
        .frame(maxWidth: .infinity, alignment: isExpanded ? .leading : .center)
        .background(
            isActive ? VColor.surfaceActive :
            isHovered ? VColor.surfaceBase :
            Color.clear
        )
        .animation(VAnimation.fast, value: isHovered)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .contentShape(Rectangle())
        .onTapGesture { action() }
        .onHover { isHovered = $0 }
        .padding(.horizontal, isExpanded ? VSpacing.sm : VSpacing.xs)
        .help(isExpanded ? "" : label)
        .pointerCursor()
    }
}

/// Convenience alias — existing callsites use `SidebarNavRow`.
typealias SidebarNavRow = SidebarPrimaryRow

// MARK: - Gallery Preview

#if DEBUG
#Preview("SidebarPrimaryRow — States") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VStack(spacing: 0) {
            // Light-style context
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Light")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .padding(.horizontal, VSpacing.sm)

                SidebarPrimaryRow(
                    icon: VIcon.layoutGrid.rawValue,
                    label: "Apps",
                    trailingIcon: VIcon.ellipsis.rawValue,
                    action: {}
                )
                SidebarPrimaryRow(
                    icon: VIcon.fileText.rawValue,
                    label: "Documents",
                    trailingIcon: VIcon.ellipsis.rawValue,
                    action: {}
                )
                SidebarPrimaryRow(
                    icon: VIcon.settings.rawValue,
                    label: "Settings",
                    isActive: true,
                    trailingIcon: VIcon.ellipsis.rawValue,
                    action: {}
                )
            }

            Divider()
                .background(VColor.borderBase)
                .padding(.vertical, VSpacing.md)

            // Collapsed mode
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Collapsed")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .padding(.horizontal, VSpacing.sm)

                SidebarPrimaryRow(
                    icon: VIcon.layoutGrid.rawValue,
                    label: "Apps",
                    isExpanded: false,
                    action: {}
                )
                SidebarPrimaryRow(
                    icon: VIcon.settings.rawValue,
                    label: "Settings",
                    isActive: true,
                    isExpanded: false,
                    action: {}
                )
            }
        }
        .padding(.vertical, VSpacing.md)
    }
    .frame(width: 220, height: 280)
}
#endif
