import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct VButton: View {
    public enum Style: Hashable { case primary, ghost, danger }
    public enum Size: Hashable { case small, medium, large }

    public let label: String
    public var icon: String? = nil
    public var style: Style = .primary
    public var size: Size = .small
    public var isFullWidth: Bool = false
    public var isDisabled: Bool = false
    public let action: () -> Void

    @State private var isHovered = false

    public init(label: String, icon: String? = nil, style: Style = .primary, size: Size = .small, isFullWidth: Bool = false, isDisabled: Bool = false, action: @escaping () -> Void) {
        self.label = label
        self.icon = icon
        self.style = style
        self.size = size
        self.isFullWidth = isFullWidth
        self.isDisabled = isDisabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: iconSize, weight: .semibold))
                }
                Text(label)
                    .font(labelFont)
            }
        }
        .buttonStyle(VButtonStyle(style: style, size: size, isHovered: isHovered, isFullWidth: isFullWidth))
        #if os(macOS)
        .onHover { hovering in
            isHovered = isDisabled ? false : hovering
            if !isDisabled {
                if hovering { NSCursor.pointingHand.set() }
                else { NSCursor.arrow.set() }
            }
        }
        #else
        .onHover { isHovered = isDisabled ? false : $0 }
        #endif
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1.0)
        .accessibilityHint(isDisabled ? "Button is currently disabled" : "")
    }

    private var iconSize: CGFloat {
        switch size {
        case .small: return 10
        case .medium: return 12
        case .large: return 14
        }
    }

    private var labelFont: Font {
        switch size {
        case .small: return VFont.monoSmall
        case .medium: return VFont.monoSmall
        case .large: return VFont.monoMedium
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
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(borderColor(isPressed: configuration.isPressed), lineWidth: style == .ghost ? 1 : 0)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
            .shadow(color: configuration.isPressed ? .clear : shadowColor, radius: 0, x: 0, y: 2)
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
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
            return isHovered ? Forest._600 : Forest._800
        case .danger:
            return isHovered ? Color(hex: 0xA53817) : Color(hex: 0x8A2F13)
        case .ghost:
            return .clear
        }
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        switch style {
        case .primary:
            if isPressed { return Forest._400 }
            if isHovered { return Forest._500 }
            return Forest._600
        case .danger:
            if isPressed { return Color(hex: 0xE0745A) }
            if isHovered { return Color(hex: 0xD4582F) }
            return Color(hex: 0xC1421B)
        case .ghost:
            if isPressed { return VColor.ghostPressed }
            if isHovered { return VColor.ghostHover }
            return .clear
        }
    }

    private var foregroundColor: Color {
        switch style {
        case .primary: return .white
        case .ghost: return VColor.textSecondary
        case .danger: return .white
        }
    }

    private func borderColor(isPressed: Bool) -> Color {
        switch style {
        case .ghost:
            if isPressed { return VColor.ghostPressed }
            return VColor.surfaceBorder
        default:
            return .clear
        }
    }
}

#Preview("VButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 16) {
            VButton(label: "Small", style: .primary, size: .small) {}
            VButton(label: "Medium", style: .primary, size: .medium) {}
            VButton(label: "Large", style: .primary, size: .large) {}
            VButton(label: "Ghost Small", style: .ghost, size: .small) {}
            VButton(label: "Ghost Large", style: .ghost, size: .large) {}
            VButton(label: "Full Width", style: .primary, isFullWidth: true) {}
        }
        .padding()
    }
    .frame(width: 300, height: 400)
}
