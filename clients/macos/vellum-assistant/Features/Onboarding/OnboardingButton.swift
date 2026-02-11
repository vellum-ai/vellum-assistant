import SwiftUI

enum OnboardingButtonStyle {
    case primary
    case ghost
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
                .font(VFont.bodyMedium)
                .foregroundColor(foregroundColor)
                .padding(.horizontal, VSpacing.xxl)
                .padding(.vertical, VSpacing.md + VSpacing.xxs)
                .background(background)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(borderColor, lineWidth: style == .ghost ? 1 : 0)
                )
        }
        .buttonStyle(.plain)
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
            return disabled ? VColor.textPrimary.opacity(0.4) : VColor.background
        case .ghost:
            return disabled ? VColor.textPrimary.opacity(0.3) : VColor.textPrimary.opacity(0.85)
        }
    }

    private var background: some ShapeStyle {
        switch style {
        case .primary:
            return AnyShapeStyle(disabled ? VColor.onboardingAccent.opacity(0.3) : VColor.onboardingAccent)
        case .ghost:
            return AnyShapeStyle(Color.clear)
        }
    }

    private var borderColor: Color {
        style == .ghost ? VColor.textPrimary.opacity(disabled ? 0.1 : 0.25) : .clear
    }

    private var opacity: Double {
        fadeIn ? (visible ? 1 : 0) : (disabled ? 0.6 : 1)
    }
}

#Preview {
    ZStack {
        VColor.background
        VStack(spacing: VSpacing.xl) {
            OnboardingButton(title: "Say hello", style: .primary) {}
            OnboardingButton(title: "Skip", style: .ghost) {}
            OnboardingButton(title: "Disabled", style: .primary, disabled: true) {}
        }
    }
    .frame(width: 400, height: 200)
}
