import VellumAssistantShared
import SwiftUI

enum OnboardingButtonStyle {
    case primary
    case secondary
    case tertiary
    case ghost
    /// Ghost layout (compact, borderless) with primary/green text color.
    case ghostPrimary
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

    private var isGhost: Bool { style == .ghost || style == .ghostPrimary }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(isGhost ? VFont.labelDefault : .system(size: 15, weight: .medium))
                .foregroundStyle(foregroundColor)
                .if(!isGhost) { $0.frame(maxWidth: .infinity) }
                .padding(.horizontal, isGhost ? VSpacing.sm : VSpacing.xl)
                .padding(.vertical, isGhost ? VSpacing.xs : VSpacing.lg)
                .contentShape(Rectangle())
                .background(
                    Group {
                        if isGhost && isHovered && !disabled {
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .fill(VColor.borderBase.opacity(0.5))
                        } else {
                            Rectangle().fill(background)
                        }
                    }
                )
                .clipShape(RoundedRectangle(cornerRadius: isGhost ? VRadius.sm : VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: isGhost ? VRadius.sm : VRadius.lg)
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
        .task {
            if fadeIn {
                try? await Task.sleep(nanoseconds: UInt64(fadeDelay * 1_000_000_000))
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.5)) {
                    visible = true
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
        case .ghost:
            return disabled ? VColor.contentSecondary.opacity(0.3) : VColor.contentSecondary
        case .ghostPrimary:
            return disabled ? VColor.primaryBase.opacity(0.3) : VColor.primaryBase
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
        case .ghost, .ghostPrimary:
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
        case .ghost, .ghostPrimary:
            return .clear
        }
    }

    private var opacity: Double {
        fadeIn ? (visible ? 1 : 0) : (disabled ? 0.6 : 1)
    }
}
