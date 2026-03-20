import SwiftUI

/// Sidebar navigation row used by both the main app sidebar and the component gallery.
///
/// Handles expanded (icon + label) and collapsed (icon-only) modes with consistent
/// spacing, backgrounds, and hover behavior. All metrics use shared design-system tokens.
///
/// Usage:
/// ```swift
/// VSidebarRow(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: true) {
///     showPanel(.intelligence)
/// }
/// ```
public struct VSidebarRow: View {
    public let icon: String?
    public let label: String
    public var isActive: Bool
    public var trailingIcon: String?
    public var trailingIconRotation: Angle
    public var isExpanded: Bool
    public let action: () -> Void

    @State private var isHovered = false

    /// Icon slot size — all leading icons occupy a uniform 20x20 frame.
    private static let iconSlotSize: CGFloat = 20

    /// Minimum row height to ensure touch/click targets remain accessible.
    private static let rowMinHeight: CGFloat = 32

    public init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        trailingIcon: String? = nil,
        trailingIconRotation: Angle = .zero,
        isExpanded: Bool = true,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.label = label
        self.isActive = isActive
        self.trailingIcon = trailingIcon
        self.trailingIconRotation = trailingIconRotation
        self.isExpanded = isExpanded
        self.action = action
    }

    private var iconColor: Color {
        isActive ? VColor.primaryActive : VColor.primaryBase
    }

    private var textColor: Color {
        isActive ? VColor.contentEmphasized : VColor.contentSecondary
    }

    public var body: some View {
        HStack(spacing: isExpanded ? VSpacing.xs : 0) {
            if let icon {
                VIconView(.resolve(icon), size: 13)
                    .foregroundColor(iconColor)
                    .frame(width: Self.iconSlotSize, height: Self.iconSlotSize)
            }
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
                        .rotationEffect(trailingIconRotation)
                        .animation(VAnimation.fast, value: trailingIconRotation)
                }
            }
        }
        .padding(.leading, isExpanded ? VSpacing.xs : 0)
        .padding(.trailing, isExpanded ? VSpacing.sm : 0)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: Self.rowMinHeight)
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
        .padding(.horizontal, 0)
        .help(isExpanded ? "" : label)
        .pointerCursor()
    }
}
