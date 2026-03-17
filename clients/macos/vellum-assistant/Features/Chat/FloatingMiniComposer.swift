import SwiftUI
import VellumAssistantShared

/// Compact composer bar that appears fixed at the top when the user scrolls
/// past the hero section. Clicking it scrolls back to the full composer.
struct FloatingMiniComposer: View {
    let visible: Bool
    let onTap: () -> Void

    private let appearance = AvatarAppearanceManager.shared

    var body: some View {
        if visible {
            Button(action: onTap) {
                HStack(spacing: VSpacing.md) {
                    Group {
                        if let body = appearance.characterBodyShape,
                           let eyes = appearance.characterEyeStyle,
                           let color = appearance.characterColor {
                            AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color, size: 20)
                                .frame(width: 20, height: 20)
                        } else {
                            VAvatarImage(image: appearance.chatAvatarImage, size: 20)
                        }
                    }

                    Text("Back to composer\u{2026}")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)

                    Spacer()

                    VIcon.arrowUp.image
                        .resizable()
                        .frame(width: 14, height: 14)
                        .foregroundColor(VColor.contentTertiary)
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(.ultraThinMaterial)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase.opacity(0.5), lineWidth: 0.5)
                )
                .shadow(color: VColor.borderBase.opacity(0.1), radius: 8, y: 2)
                .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
            }
            .buttonStyle(.plain)
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.sm)
            .transition(.move(edge: .top).combined(with: .opacity))
            .animation(VAnimation.fast, value: visible)
        }
    }
}
