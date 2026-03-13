import SwiftUI

public struct VButton: View {
    public enum Style: Hashable { case primary, danger, dangerOutline, outlined, ghost, neutral }

    public let label: String
    public var leftIcon: String? = nil
    public var rightIcon: String? = nil
    public var iconOnly: String? = nil
    public var style: Style = .primary
    public var isFullWidth: Bool = false
    public var isDisabled: Bool = false
    public var isActive: Bool = false
    public var iconSize: CGFloat? = nil
    public var tooltip: String? = nil
    public var accessibilityID: String? = nil
    public let action: () -> Void

    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    public init(label: String, icon: String? = nil, leftIcon: String? = nil, rightIcon: String? = nil, iconOnly: String? = nil, style: Style = .primary, isFullWidth: Bool = false, isDisabled: Bool = false, isActive: Bool = false, iconSize: CGFloat? = nil, tooltip: String? = nil, accessibilityID: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.leftIcon = leftIcon ?? icon
        self.rightIcon = rightIcon
        self.iconOnly = iconOnly
        self.style = style
        self.isFullWidth = isFullWidth
        self.isDisabled = isDisabled
        self.isActive = isActive
        self.iconSize = iconSize
        self.tooltip = tooltip
        self.accessibilityID = accessibilityID
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            if let iconOnly {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.resolve(iconOnly), size: 13)
                        .frame(width: 20, height: 20)
                }
                .foregroundColor(iconOnlyForegroundColor)
            } else {
                HStack(spacing: VSpacing.sm) {
                    if let leftIcon {
                        VIconView(.resolve(leftIcon), size: textIconSize)
                    }
                    Text(label)
                        .font(VFont.bodyMedium)
                    if isFullWidth && (leftIcon != nil || rightIcon != nil) {
                        Spacer(minLength: 0)
                    }
                    if let rightIcon {
                        VIconView(.resolve(rightIcon), size: textIconSize)
                    }
                }
            }
        }
        .focused($isFocused)
        .buttonStyle(VButtonStyle(
            style: style,
            isHovered: isHovered,
            isFullWidth: isFullWidth,
            isIconOnly: iconOnly != nil,
            isActive: isActive,
            isFocused: isFocused,
            iconSize: iconSize
        ))
        .onHover { hovering in
            isHovered = isDisabled ? false : hovering
        }
        .pointerCursor()
        .disabled(isDisabled)
        .accessibilityLabel(iconOnly != nil ? label : "")
        .accessibilityHint(isDisabled ? "Button is currently disabled" : "")
        .optionalAccessibilityIdentifier(accessibilityID)
        .modifier(OptionalHelpModifier(tooltip: tooltip))
    }

    private var textIconSize: CGFloat { 13 }

    private var iconOnlyForegroundColor: Color {
        switch style {
        case .primary, .danger, .neutral:
            return VColor.auxWhite
        case .ghost, .outlined, .dangerOutline:
            if isActive { return VColor.primaryActive }
            return VColor.primaryBase
        }
    }
}

public struct VButtonStyle: ButtonStyle {
    let style: VButton.Style
    let isHovered: Bool
    let isFullWidth: Bool
    let isIconOnly: Bool
    let isActive: Bool
    let isFocused: Bool
    let iconSize: CGFloat?

    /// Creates an icon-only button style for custom button compositions.
    public static func iconOnly(style: VButton.Style = .ghost, isHovered: Bool, isFocused: Bool = false, isActive: Bool = false, iconSize: CGFloat? = nil) -> VButtonStyle {
        VButtonStyle(style: style, isHovered: isHovered, isFullWidth: false, isIconOnly: true, isActive: isActive, isFocused: isFocused, iconSize: iconSize)
    }

    init(style: VButton.Style, isHovered: Bool, isFullWidth: Bool, isIconOnly: Bool = false, isActive: Bool = false, isFocused: Bool = false, iconSize: CGFloat? = nil) {
        self.style = style
        self.isHovered = isHovered
        self.isFullWidth = isFullWidth
        self.isIconOnly = isIconOnly
        self.isActive = isActive
        self.isFocused = isFocused
        self.iconSize = iconSize
    }

    @Environment(\.isEnabled) private var isEnabled

    public func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: VRadius.md)

        configuration.label
            .foregroundColor(foregroundColor)
            .modifier(ButtonLayoutModifier(
                style: style,
                isIconOnly: isIconOnly,
                isFullWidth: isFullWidth,
                iconSize: iconSize
            ))
            .background(shape.fill(backgroundColor(isPressed: configuration.isPressed)))
            .overlay(
                shape.strokeBorder(
                    borderColor(isPressed: configuration.isPressed),
                    lineWidth: borderLineWidth
                )
            )
            .clipShape(shape)
            .contentShape(shape)
            .focusEffectDisabled()
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
    }

    private var borderLineWidth: CGFloat {
        switch style {
        case .outlined, .dangerOutline: return 2
        case .ghost:
            return isEnabled && isFocused ? 1.25 : 1
        default: return 0
        }
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        switch style {
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
        case .outlined, .dangerOutline:
            if isIconOnly {
                if isPressed { return VColor.surfaceActive }
                if isHovered { return VColor.surfaceBase }
            }
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
        case .neutral:
            guard isEnabled else { return VColor.contentDisabled }
            if isPressed { return VColor.contentEmphasized }
            if isHovered { return VColor.contentSecondary }
            return VColor.contentDefault
        }
    }

    private var foregroundColor: Color {
        guard isEnabled else { return VColor.contentDisabled }
        switch style {
        case .primary: return VColor.auxWhite
        case .danger: return VColor.auxWhite
        case .neutral: return VColor.auxWhite
        case .outlined: return isHovered ? VColor.primaryHover : VColor.primaryBase
        case .dangerOutline: return isHovered ? VColor.systemNegativeHover : VColor.systemNegativeStrong
        case .ghost:
            if isHovered { return VColor.primaryActive }
            return VColor.primaryBase
        }
    }

    private func borderColor(isPressed: Bool) -> Color {
        switch style {
        case .outlined:
            if isIconOnly {
                return VColor.borderActive
            }
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.primaryActive }
            if isHovered { return VColor.primaryHover }
            return VColor.primaryBase
        case .dangerOutline:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.systemNegativeHover }
            if isHovered { return VColor.systemNegativeHover }
            return VColor.systemNegativeStrong
        case .ghost:
            guard isEnabled, isFocused else { return .clear }
            return VColor.primaryBase.opacity(0.72)
        default:
            return .clear
        }
    }
}

private struct ButtonLayoutModifier: ViewModifier {
    let style: VButton.Style
    let isIconOnly: Bool
    let isFullWidth: Bool
    let iconSize: CGFloat?

    func body(content: Content) -> some View {
        if isIconOnly {
            content
                .frame(width: iconSize, height: iconSize)
                .padding(iconSize == nil ? VSpacing.xs : 0)
        } else {
            content
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.buttonV)
                .frame(height: 28)
                .frame(maxWidth: isFullWidth ? .infinity : nil)
        }
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

private extension View {
    @ViewBuilder
    func optionalAccessibilityIdentifier(_ identifier: String?) -> some View {
        if let identifier {
            self.accessibilityIdentifier(identifier)
        } else {
            self
        }
    }
}
