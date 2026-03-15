import VellumAssistantShared
import SwiftUI

/// The revealed creature with spring entrance and breathing animation.
/// Now shows the avatar image (custom or initial-letter fallback) instead of a pixel blob.
struct CreatureView: View {
    let visible: Bool
    var animated: Bool = true
    @State private var appearance = AvatarAppearanceManager.shared

    // Precomputed transparency flag — avoids expensive bitmap analysis during animation frames.
    @State private var avatarIsTransparent = false

    @State private var appeared = false
    @State private var bounceOffset: CGFloat = 0
    @State private var breatheScaleY: CGFloat = 1.0
    @State private var breatheScaleX: CGFloat = 1.0

    var body: some View {
        if visible {
            avatarImage
                .scaleEffect(x: breatheScaleX, y: breatheScaleY, anchor: .bottom)
                .offset(y: bounceOffset)
                .scaleEffect(appeared ? 1.0 : 0.0)
                .opacity(appeared ? 1.0 : 0.0)
                .onAppear {
                    avatarIsTransparent = VAvatarImage.imageHasTransparency(appearance.fullAvatarImage)
                    if animated {
                        withAnimation(.spring(response: 0.6, dampingFraction: 0.5, blendDuration: 0)) {
                            appeared = true
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            withAnimation(.easeOut(duration: 0.6)) {
                                bounceOffset = -15
                            }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                withAnimation(.easeIn(duration: 0.3)) {
                                    bounceOffset = 0
                                }
                            }
                        }
                    } else {
                        appeared = true
                    }
                    let breatheDelay: Double = animated ? 1.0 : 0.0
                    DispatchQueue.main.asyncAfter(deadline: .now() + breatheDelay) {
                        withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) {
                            breatheScaleY = 1.03
                            breatheScaleX = 0.98
                        }
                    }
                }
        }
    }

    private var avatarImage: some View {
        VAvatarImage(image: appearance.fullAvatarImage, size: 200, isTransparent: avatarIsTransparent, showBorder: false)
            .shadow(radius: 8)
    }
}
