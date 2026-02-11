import SwiftUI

struct VButton: View {
    enum Style { case primary, ghost, danger }

    let label: String
    var style: Style = .primary
    var isFullWidth: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    @State private var isPressed = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.bodyMedium)
                .foregroundColor(foregroundColor)
                .frame(maxWidth: isFullWidth ? .infinity : nil)
                .padding(.horizontal, VSpacing.xl)
                .padding(.vertical, VSpacing.lg)
                .background(backgroundColor)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(borderColor, lineWidth: style == .ghost ? 1 : 0)
                )
        }
        .buttonStyle(.plain)
        .scaleEffect(isPressed ? 0.97 : 1.0)
        .animation(VAnimation.fast, value: isPressed)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1.0)
        .onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in
            isPressed = pressing
        }, perform: {})
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
