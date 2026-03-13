import SwiftUI

public struct VButton: View {
    public enum Style: Hashable { case primary, danger, dangerOutline, outlined }

    public let label: String
    public var leftIcon: String? = nil
    public var rightIcon: String? = nil
    public var style: Style = .primary
    public var isFullWidth: Bool = false
    public var isDisabled: Bool = false
    public var accessibilityID: String? = nil
    public let action: () -> Void

    @State private var isHovered = false

    public init(label: String, icon: String? = nil, leftIcon: String? = nil, rightIcon: String? = nil, style: Style = .primary, isFullWidth: Bool = false, isDisabled: Bool = false, accessibilityID: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.leftIcon = leftIcon ?? icon
        self.rightIcon = rightIcon
        self.style = style
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
                    .font(VFont.bodyMedium)
                if isFullWidth && (leftIcon != nil || rightIcon != nil) {
                    Spacer(minLength: 0)
                }
                if let rightIcon {
                    VIconView(.resolve(rightIcon), size: iconSize)
                }
            }
        }
        .buttonStyle(VButtonStyle(style: style, isHovered: isHovered, isFullWidth: isFullWidth))
        .onHover { hovering in
            isHovered = isDisabled ? false : hovering
        }
        .pointerCursor()
        .disabled(isDisabled)
        .accessibilityHint(isDisabled ? "Button is currently disabled" : "")
        .optionalAccessibilityIdentifier(accessibilityID)
    }

    private var iconSize: CGFloat { 13 }
}

private struct VButtonStyle: ButtonStyle {
    let style: VButton.Style
    let isHovered: Bool
    let isFullWidth: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(foregroundColor)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.buttonV)
            .frame(height: 28)
            .frame(maxWidth: isFullWidth ? .infinity : nil)
            .background(backgroundColor(isPressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .strokeBorder(borderColor(isPressed: configuration.isPressed), lineWidth: borderLineWidth)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
    }

    private var borderLineWidth: CGFloat {
        switch style {
        case .outlined, .dangerOutline: return 2
        default: return 0
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
        case .danger:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.systemNegativeHover }
            if isHovered { return VColor.systemNegativeHover }
            return VColor.systemNegativeStrong
        case .outlined, .dangerOutline:
            return .clear
        }
    }

    private var foregroundColor: Color {
        guard isEnabled else { return VColor.contentDisabled }
        switch style {
        case .primary: return VColor.auxWhite
        case .danger: return VColor.auxWhite
        case .outlined: return isHovered ? VColor.primaryHover : VColor.primaryBase
        case .dangerOutline: return isHovered ? VColor.systemNegativeHover : VColor.systemNegativeStrong
        }
    }

    private func borderColor(isPressed: Bool) -> Color {
        switch style {
        case .outlined:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.primaryActive }
            if isHovered { return VColor.primaryHover }
            return VColor.primaryBase
        case .dangerOutline:
            guard isEnabled else { return VColor.primaryDisabled }
            if isPressed { return VColor.systemNegativeHover }
            if isHovered { return VColor.systemNegativeHover }
            return VColor.systemNegativeStrong
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
