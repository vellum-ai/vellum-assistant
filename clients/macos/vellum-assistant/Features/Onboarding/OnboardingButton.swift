import VellumAssistantShared
import SwiftUI

enum OnboardingButtonStyle {
    case primary
    case secondary
    case tertiary
}

struct OnboardingButton: View {
    let title: String
    var style: OnboardingButtonStyle = .primary
    var disabled: Bool = false
    var fadeIn: Bool = false
    var fadeDelay: TimeInterval = 0
    let action: () -> Void

    @State private var visible = false
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(foregroundColor)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, VSpacing.xl)
                .padding(.vertical, VSpacing.lg)
                .contentShape(Rectangle())
                .background(background)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(borderColor, lineWidth: style == .primary ? 0 : 1)
                )
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .disabled(disabled)
        .opacity(opacity)
        .scaleEffect(isHovered && !disabled ? 1.03 : 1.0)
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
        .onAppear {
            if fadeIn {
                DispatchQueue.main.asyncAfter(deadline: .now() + fadeDelay) {
                    withAnimation(.easeOut(duration: 0.5)) {
                        visible = true
                    }
                }
            } else {
                visible = true
            }
        }
    }

    private var foregroundColor: Color {
        switch style {
        case .primary:
            return disabled ? VColor.auxWhite.opacity(0.4) : VColor.auxWhite
        case .secondary:
            return disabled ? VColor.primaryBase.opacity(0.3) : VColor.primaryBase
        case .tertiary:
            return disabled ? VColor.contentDefault.opacity(0.3) : VColor.contentDefault.opacity(0.85)
        }
    }

    private var background: some ShapeStyle {
        switch style {
        case .primary:
            return AnyShapeStyle(disabled ? VColor.primaryBase.opacity(0.3) : VColor.primaryBase)
        case .secondary:
            return AnyShapeStyle(Color.clear)
        case .tertiary:
            return AnyShapeStyle(Color.clear)
        }
    }

    private var borderColor: Color {
        switch style {
        case .primary:
            return .clear
        case .secondary:
            return VColor.primaryBase.opacity(disabled ? 0.2 : 0.5)
        case .tertiary:
            return VColor.contentDefault.opacity(disabled ? 0.1 : 0.25)
        }
    }

    private var opacity: Double {
        fadeIn ? (visible ? 1 : 0) : (disabled ? 0.6 : 1)
    }
}

#Preview {
    ZStack {
        VColor.surfaceOverlay
        VStack(spacing: VSpacing.xl) {
            OnboardingButton(title: "Say hello", style: .primary) {}
            OnboardingButton(title: "Skip", style: .tertiary) {}
            OnboardingButton(title: "Disabled", style: .primary, disabled: true) {}
        }
        .frame(width: 300)
    }
    .frame(width: 400, height: 200)
}
