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
        .opacity(isDisabled ? 0.5 : 1.0)
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

    private func backgroundColor(isPressed: Bool) -> Color {
        switch style {
        case .primary:
            if isPressed { return VColor.buttonPrimaryPressed }
            if isHovered { return VColor.buttonPrimaryHover }
            return VColor.buttonPrimary
        case .secondary:
            if isPressed { return VColor.buttonSecondaryBgPressed }
            if isHovered { return VColor.buttonSecondaryBgHover }
            return VColor.buttonSecondaryBg
        case .danger:
            if isPressed { return Color(hex: 0xE0745A) }
            if isHovered { return Color(hex: 0xD4582F) }
            return Color(hex: 0xC1421B)
        case .tertiary:
            if isPressed { return VColor.ghostPressed }
            if isHovered { return VColor.ghostHover }
            return .clear
        case .ghost:
            if isPressed { return VColor.ghostPressed }
            if isHovered { return VColor.ghostHover }
            return .clear
        case .outlined:
            return .clear
        case .success:
            if isPressed { return adaptiveColor(light: Forest._400, dark: Forest._700) }
            if isHovered { return adaptiveColor(light: Forest._300, dark: Forest._800) }
            return adaptiveColor(light: Forest._200, dark: Forest._900)
        }
    }

    private var foregroundColor: Color {
        switch style {
        case .primary: return .white
        case .tertiary: return VColor.buttonSecondaryText
        case .secondary: return adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._400)
        case .danger: return .white
        case .ghost: return Color(hex: 0x537D53)
        case .outlined: return VColor.buttonSecondaryText
        case .success: return adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._300)
        }
    }

    private func borderColor(isPressed: Bool) -> Color {
        switch style {
        case .tertiary:
            if isPressed { return VColor.ghostPressed }
            return VColor.buttonSecondaryBorder
        case .outlined:
            if isPressed { return VColor.buttonSecondaryBorder.opacity(0.7) }
            return VColor.buttonSecondaryBorder
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

#Preview("VButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 16) {
            VButton(label: "Primary", style: .primary, size: .medium) {}
            VButton(label: "Secondary", style: .secondary, size: .medium) {}
            VButton(label: "Tertiary", style: .tertiary, size: .medium) {}
            VButton(label: "Danger", style: .danger, size: .medium) {}
            VButton(label: "Ghost", style: .ghost, size: .medium) {}
            VButton(label: "Record", style: .outlined, size: .large) {}
            HStack(spacing: 12) {
                VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success, size: .medium) {}
                VButton(label: "Disconnect", style: .danger, size: .medium) {}
            }
            VButton(label: "Connect", style: .primary, size: .medium) {}
            VButton(label: "With Icon", leftIcon: VIcon.plus.rawValue, style: .primary, size: .small) {}
            VButton(label: "Full Width", style: .primary, isFullWidth: true) {}
            VButton(label: "Disabled", style: .primary, isDisabled: true) {}
        }
        .padding()
    }
    .frame(width: 320, height: 580)
}
