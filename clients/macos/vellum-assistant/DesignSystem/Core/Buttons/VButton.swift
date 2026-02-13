import SwiftUI

struct VButton: View {
    enum Style: Hashable { case primary, ghost, danger }

    let label: String
    var style: Style = .primary
    var isFullWidth: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.bodyMedium)
        }
        .buttonStyle(VButtonStyle(style: style, isHovered: isHovered, isFullWidth: isFullWidth))
        .onHover { isHovered = isDisabled ? false : $0 }
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1.0)
        .accessibilityHint(isDisabled ? "Button is currently disabled" : "")
    }
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

    private var shadowColor: Color {
        switch style {
        case .primary:
            return isHovered ? Violet._600 : Violet._800
        case .danger:
            return isHovered ? Rose._700 : Rose._800
        case .ghost:
            return isHovered ? Slate._600 : Slate._700
        }
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        switch style {
        case .primary:
            if isPressed { return Violet._400 }
            if isHovered { return Violet._500 }
            return Violet._600
        case .danger:
            if isPressed { return Rose._400 }
            if isHovered { return Rose._500 }
            return Rose._600
        case .ghost:
            if isPressed { return Slate._600 }
            if isHovered { return Slate._700 }
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
            if isPressed { return Slate._600 }
            return Slate._700
        default:
            return .clear
        }
    }
}

#Preview("VButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 16) {
            VButton(label: "Primary", style: .primary) {}
            VButton(label: "Ghost", style: .ghost) {}
            VButton(label: "Danger", style: .danger) {}
            VButton(label: "Disabled", style: .primary, isDisabled: true) {}
            VButton(label: "Full Width", style: .primary, isFullWidth: true) {}
        }
        .padding()
    }
    .frame(width: 300, height: 300)
}
