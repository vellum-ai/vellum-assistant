import SwiftUI

public struct VButton: View {
    public enum Style: Hashable { case primary, secondary, tertiary, danger, ghost, outlined, success }
    public enum Size: Hashable { case small, medium, large }

    public let label: String
    public var leftIcon: String? = nil
    public var rightIcon: String? = nil
    public var style: Style = .primary
    public var size: Size = .small
    public var isFullWidth: Bool = false
    public var isDisabled: Bool = false
    public var accessibilityID: String? = nil
    public let action: () -> Void

    @State private var isHovered = false

    public init(label: String, icon: String? = nil, leftIcon: String? = nil, rightIcon: String? = nil, style: Style = .primary, size: Size = .small, isFullWidth: Bool = false, isDisabled: Bool = false, accessibilityID: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.leftIcon = leftIcon ?? icon
        self.rightIcon = rightIcon
        self.style = style
        self.size = size
        self.isFullWidth = isFullWidth
        self.isDisabled = isDisabled
        self.accessibilityID = accessibilityID
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                if let leftIcon {
                    VIconView(.resolve(leftIcon), size: iconSize)
                }
                Text(label)
                    .font(labelFont)
                    .fontWeight(style == .ghost || style == .tertiary ? .medium : .regular)
                if isFullWidth && (leftIcon != nil || rightIcon != nil) {
                    Spacer(minLength: 0)
                }
                if let rightIcon {
                    VIconView(.resolve(rightIcon), size: iconSize)
                }
            }
        }
        .buttonStyle(VButtonStyle(style: style, size: size, isHovered: isHovered, isFullWidth: isFullWidth))
        .onHover { hovering in
            isHovered = isDisabled ? false : hovering
        }
        .pointerCursor()
        .disabled(isDisabled)
        .accessibilityHint(isDisabled ? "Button is currently disabled" : "")
        .optionalAccessibilityIdentifier(accessibilityID)
    }

    private var iconSize: CGFloat { 13 }

    private var labelFont: Font {
        switch size {
        case .small: return VFont.caption
        case .medium: return VFont.bodyMedium
        case .large: return VFont.buttonLarge
        }
    }
}

private struct VButtonStyle: ButtonStyle {
    let style: VButton.Style
    let size: VButton.Size
    let isHovered: Bool
    let isFullWidth: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(foregroundColor)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, VSpacing.buttonV)
            .frame(height: height)
            .frame(maxWidth: isFullWidth ? .infinity : nil)
            .background(backgroundColor(isPressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(borderColor(isPressed: configuration.isPressed), lineWidth: borderLineWidth)
            )
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius))
            .shadow(color: configuration.isPressed ? .clear : shadowColor, radius: 0, x: 0, y: 2)
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
    }

    private var cornerRadius: CGFloat {
        return VRadius.md
    }

    private var borderLineWidth: CGFloat {
        switch style {
        case .tertiary: return 2
        case .outlined: return 2.5
        default: return 0
        }
    }

    private var height: CGFloat {
        switch size {
        case .small: return 24
        case .medium: return 28
        case .large: return 32
        }
    }

    private var horizontalPadding: CGFloat {
        switch size {
        case .small: return VSpacing.md
        case .medium: return VSpacing.md
        case .large: return VSpacing.lg
        }
    }

    private var shadowColor: Color {
        switch style {
        case .primary:
            return .clear
        case .danger:
            return .clear
        case .tertiary, .ghost:
            return .clear
        case .secondary:
            return .clear
        case .outlined, .success:
            return .clear
        }
    }

    @Environment(\.isEnabled) private var isEnabled

    private func backgroundColor(isPressed: Bool) -> Color {
        switch style {
        case .primary:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.primaryActive }
            if isHovered { return VColor.primaryHover }
            return VColor.primaryBase
        case .secondary:
            guard isEnabled else { return VColor.surfaceBase }
            if isPressed { return VColor.surfaceActive }
            if isHovered { return VColor.surfaceActive }
            return VColor.surfaceBase
        case .danger:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.systemNegativeHover }
            if isHovered { return VColor.systemNegativeHover }
            return VColor.systemNegativeStrong
        case .tertiary:
            if isPressed { return VColor.surfaceActive }
            if isHovered { return VColor.surfaceBase }
            return .clear
        case .ghost:
            if isPressed { return VColor.surfaceActive }
            if isHovered { return VColor.surfaceBase }
            return .clear
        case .outlined:
            return .clear
        case .success:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.primaryBase }
            if isHovered { return VColor.primaryHover }
            return VColor.systemPositiveWeak
        }
    }

    private var foregroundColor: Color {
        guard isEnabled else { return VColor.contentDisabled }
        switch style {
        case .primary: return VColor.auxWhite
        case .tertiary: return VColor.primaryBase
        case .secondary: return VColor.primaryBase
        case .danger: return VColor.auxWhite
        case .ghost: return VColor.primaryBase
        case .outlined: return VColor.primaryBase
        case .success: return VColor.primaryActive
        }
    }

    private func borderColor(isPressed: Bool) -> Color {
        switch style {
        case .tertiary:
            if isPressed { return VColor.surfaceActive }
            return VColor.borderActive
        case .outlined:
            if isPressed { return VColor.borderActive.opacity(0.7) }
            return VColor.borderActive
        case .secondary, .ghost, .success:
            return .clear
        default:
            return .clear
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

