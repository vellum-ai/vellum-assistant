import SwiftUI

/// Sidebar navigation row used by both the main app sidebar and the component gallery.
///
/// Handles expanded (icon + label) and collapsed (icon-only) modes with consistent
/// spacing, backgrounds, and hover behavior. All metrics use shared design-system tokens.
///
/// Usage:
/// ```swift
/// VNavItem(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: true) {
///     showPanel(.intelligence)
/// }
///
/// // With trailing content:
/// VNavItem(label: "Identity", isActive: true, action: { }) {
///     Text("5").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
/// }
/// ```
public struct VNavItem<Trailing: View>: View {
    public let icon: String?
    public let label: String
    public var subtitle: String?
    public var isActive: Bool
    public var isExpanded: Bool
    /// When `true`, applies the keyboard-focus highlight background (same as hover).
    /// Managed by `VMenuCoordinator` via the Observation framework.
    /// On iOS this property is always `false` (no-op).
    public var isKeyboardFocused: Bool
    public let action: () -> Void
    public let trailing: Trailing

    @State private var isHovered = false

    private static var iconSlotSize: CGFloat { VSize.iconSlot }
    private static var rowMinHeight: CGFloat { VSize.rowMinHeight }

    public init(
        icon: String? = nil,
        label: String,
        subtitle: String? = nil,
        isActive: Bool = false,
        isExpanded: Bool = true,
        isKeyboardFocused: Bool = false,
        action: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.icon = icon
        self.label = label
        self.subtitle = subtitle
        self.isActive = isActive
        self.isExpanded = isExpanded
        self.isKeyboardFocused = isKeyboardFocused
        self.action = action
        self.trailing = trailing()
    }

    private var iconColor: Color {
        isActive ? VColor.contentDefault : VColor.contentTertiary
    }

    private var textColor: Color {
        isActive ? VColor.contentEmphasized : VColor.contentSecondary
    }

    public var body: some View {
        HStack(spacing: isExpanded ? VSpacing.xs : 0) {
            if let icon {
                VIconView(.resolve(icon), size: VSize.iconDefault)
                    .foregroundStyle(iconColor)
                    .frame(width: Self.iconSlotSize, height: Self.iconSlotSize)
            }
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(textColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let subtitle, isExpanded {
                    Text(subtitle)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(width: isExpanded ? nil : 0, alignment: .leading)
            .clipped()
            .opacity(isExpanded ? 1 : 0)
            .allowsHitTesting(false)
            if isExpanded {
                Spacer()
                trailing
            }
        }
        .padding(.leading, isExpanded ? VSpacing.xs : 0)
        .padding(.trailing, isExpanded ? VSpacing.sm : 0)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: Self.rowMinHeight)
        .frame(maxWidth: .infinity, alignment: isExpanded ? .leading : .center)
        .background(navItemBackground)
        .animation(VAnimation.fast, value: isHovered)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .contentShape(Rectangle())
        .onTapGesture { action() }
        .padding(.horizontal, 0)
        .vTooltip(label)
        .pointerCursor(onHover: { isHovered = $0 })
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isButton)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
        .accessibilityAction { action() }
    }

    private var navItemBackground: Color {
        if isActive { return VColor.surfaceActive }
        if isKeyboardFocused { return VColor.systemPositiveWeak }
        if isHovered { return VColor.surfaceBase }
        return .clear
    }
}

// MARK: - Convenience initializers

public extension VNavItem where Trailing == EmptyView {
    /// Simple row with no trailing content.
    init(
        icon: String? = nil,
        label: String,
        subtitle: String? = nil,
        isActive: Bool = false,
        isExpanded: Bool = true,
        isKeyboardFocused: Bool = false,
        action: @escaping () -> Void
    ) {
        self.init(
            icon: icon,
            label: label,
            subtitle: subtitle,
            isActive: isActive,
            isExpanded: isExpanded,
            isKeyboardFocused: isKeyboardFocused,
            action: action
        ) {
            EmptyView()
        }
    }
}

public extension VNavItem where Trailing == VNavItemTrailingIcon {
    /// Row with a trailing icon and optional rotation (used by the main sidebar for disclosure arrows).
    init(
        icon: String? = nil,
        label: String,
        subtitle: String? = nil,
        isActive: Bool = false,
        trailingIcon: String,
        trailingIconRotation: Angle = .zero,
        isExpanded: Bool = true,
        action: @escaping () -> Void
    ) {
        let active = isActive
        self.init(
            icon: icon,
            label: label,
            subtitle: subtitle,
            isActive: isActive,
            isExpanded: isExpanded,
            isKeyboardFocused: false,
            action: action
        ) {
            VNavItemTrailingIcon(
                icon: trailingIcon,
                rotation: trailingIconRotation,
                isActive: active
            )
        }
    }
}

/// Trailing icon view extracted so the convenience init can reference a concrete type.
public struct VNavItemTrailingIcon: View {
    let icon: String
    var rotation: Angle = .zero
    var isActive: Bool = false

    private var iconColor: Color {
        isActive ? VColor.contentDefault : VColor.contentTertiary
    }

    public var body: some View {
        VIconView(.resolve(icon), size: 13)
            .foregroundStyle(iconColor)
            .rotationEffect(rotation)
            .animation(VAnimation.fast, value: rotation)
    }
}
