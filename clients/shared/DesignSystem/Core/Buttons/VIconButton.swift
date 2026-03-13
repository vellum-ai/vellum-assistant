import SwiftUI

public enum VIconButtonVariant {
    case ghost
    case primary
    case secondary
    case danger
    case success
    case outlined
    case neutral
}

public struct VIconButton: View {
    public let label: String
    public var icon: String = ""
    public var customIcon: Image? = nil
    public var isActive: Bool = false
    public var iconOnly: Bool = false
    public var variant: VIconButtonVariant = .ghost
    public var size: CGFloat? = nil
    public var tooltip: String? = nil
    public let action: () -> Void

    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    public init(label: String, icon: String = "", customIcon: Image? = nil, isActive: Bool = false, iconOnly: Bool = false, variant: VIconButtonVariant = .ghost, size: CGFloat? = nil, tooltip: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.icon = icon
        self.customIcon = customIcon
        self.isActive = isActive
        self.iconOnly = iconOnly
        self.variant = variant
        self.size = size
        self.tooltip = tooltip
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                if let customIcon {
                    customIcon
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 20, height: 20)
                } else {
                    VIconView(.resolve(icon), size: 13)
                        .frame(width: 20, height: 20)
                }
                if !iconOnly {
                    Text(label)
                        .font(VFont.caption)
                }
            }
            .foregroundColor(iconForegroundForVariant)
        }
        .focused($isFocused)
        .buttonStyle(VIconButtonStyle(isActive: isActive, isHovered: isHovered, isFocused: isFocused, size: size, variant: variant))
        .pointerCursor(onHover: { hovering in
            isHovered = hovering
        })
        .accessibilityLabel(label)
        .modifier(OptionalHelpModifier(tooltip: tooltip))
    }

    private var iconForegroundForVariant: Color {
        switch variant {
        case .primary, .danger, .success, .neutral:
            return VColor.auxWhite
        case .ghost, .secondary, .outlined:
            return iconForegroundColor
        }
    }

    private var iconForegroundColor: Color {
        if isActive {
            return VColor.primaryActive
        }
        return VColor.primaryBase
    }
}

/// Applies `.help()` only when a tooltip string is provided, avoiding an
/// empty help wrapper that can affect hit-testing and hover behavior.
private struct OptionalHelpModifier: ViewModifier {
    let tooltip: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let tooltip {
            content.help(tooltip)
        } else {
            content
        }
    }
}

public struct VIconButtonStyle: ButtonStyle {
    public var isActive: Bool
    public var isHovered: Bool
    public var isFocused: Bool
    public var size: CGFloat?
    public var variant: VIconButtonVariant

    @Environment(\.isEnabled) private var isEnabled

    public init(isActive: Bool = false, isHovered: Bool, isFocused: Bool = false, size: CGFloat? = nil, variant: VIconButtonVariant = .ghost) {
        self.isActive = isActive
        self.isHovered = isHovered
        self.isFocused = isFocused
        self.size = size
        self.variant = variant
    }

    public func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: VRadius.md)

        configuration.label
            .frame(width: size, height: size)
            .padding(size == nil ? VSpacing.xs : 0)
            .background(shape.fill(backgroundColor(isPressed: configuration.isPressed)))
            .overlay(
                shape.strokeBorder(
                    borderColor,
                    lineWidth: borderLineWidth
                )
            )
            .clipShape(shape)
            .contentShape(shape)
            .focusEffectDisabled()
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(VAnimation.fast, value: configuration.isPressed)
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        switch variant {
        case .primary:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.primaryActive }
            if isHovered { return VColor.primaryHover }
            return VColor.primaryBase

        case .danger:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.systemNegativeHover }
            if isHovered { return VColor.systemNegativeHover }
            return VColor.systemNegativeStrong

        case .success:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.primaryBase }
            if isHovered { return VColor.primaryHover }
            return VColor.systemPositiveWeak

        case .neutral:
            guard isEnabled else { return VColor.contentDisabled }
            if isPressed { return VColor.contentEmphasized }
            if isHovered { return VColor.contentSecondary }
            return VColor.contentDefault

        case .secondary:
            guard isEnabled else { return VColor.surfaceActive }
            if isPressed { return VColor.surfaceActive }
            if isHovered { return VColor.surfaceActive }
            return VColor.surfaceBase

        case .outlined:
            if isPressed { return VColor.surfaceActive }
            if isHovered { return VColor.surfaceBase }
            return .clear

        case .ghost:
            guard isEnabled else {
                return isActive ? VColor.borderDisabled : .clear
            }
            if isActive {
                if isPressed { return VColor.surfaceActive }
                if isHovered { return VColor.surfaceActive }
                return VColor.surfaceBase
            } else {
                if isPressed { return VColor.surfaceActive }
                if isHovered { return VColor.surfaceBase }
                return .clear
            }
        }
    }

    private var borderLineWidth: CGFloat {
        if case .outlined = variant { return 2 }
        return isEnabled && isFocused ? 1.25 : 1
    }

    private var borderColor: Color {
        switch variant {
        case .primary, .danger, .success, .neutral:
            return .clear
        case .outlined:
            return VColor.borderActive
        case .ghost, .secondary:
            guard isEnabled, isFocused else { return .clear }
            return VColor.primaryBase.opacity(0.72)
        }
    }
}

