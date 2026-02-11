import SwiftUI

struct VButton: View {
    enum Style: Hashable { case primary, ghost, danger }

    let label: String
    var style: Style = .primary
    var isFullWidth: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.bodyMedium)
                .foregroundColor(foregroundColor)
                .padding(.horizontal, VSpacing.xl)
                .padding(.vertical, VSpacing.lg)
                .frame(maxWidth: isFullWidth ? .infinity : nil)
                .background(backgroundColor)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(borderColor, lineWidth: style == .ghost ? 1 : 0)
                )
        }
        .buttonStyle(VButtonPressStyle())
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1.0)
        .accessibilityHint(isDisabled ? "Button is currently disabled" : "")
    }

    private var backgroundColor: Color {
        switch style {
        case .primary: return VColor.accent
        case .ghost: return .clear
        case .danger: return VColor.error
        }
    }

    private var foregroundColor: Color {
        switch style {
        case .primary: return .white
        case .ghost: return VColor.textSecondary
        case .danger: return .white
        }
    }

    private var borderColor: Color {
        switch style {
        case .ghost: return VColor.surfaceBorder
        default: return .clear
        }
    }
}

private struct VButtonPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .animation(VAnimation.fast, value: configuration.isPressed)
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
