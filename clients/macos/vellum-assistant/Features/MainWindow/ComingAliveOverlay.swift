import SwiftUI
import VellumAssistantShared

/// Full-screen overlay shown briefly after onboarding completes.
/// Displays the avatar with a bouncy scale-up animation and a
/// radiating accent glow pulse, then calls `onComplete` so the caller
/// can fade in the chat UI and send the wake-up message.
struct ComingAliveOverlay: View {
    let onComplete: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared

    // Animation state
    @State private var avatarScale: CGFloat = 0.0
    @State private var avatarOpacity: Double = 0.0
    @State private var glowScale: CGFloat = 0.6
    @State private var glowOpacity: Double = 0.0

    /// Total transition budget: ~1.5 seconds.
    /// - 0.0s: avatar springs in (bouncy, ~0.6s settle)
    /// - 0.2s: glow pulse starts (0.8s expand + fade)
    /// - 1.4s: onComplete fires
    private let completionDelay: TimeInterval = 1.4

    var body: some View {
        ZStack {
            VColor.surfaceOverlay
                .ignoresSafeArea()

            // Radiating glow pulse
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Meadow.avatarGradientStart.opacity(glowOpacity),
                            Meadow.avatarGradientStart.opacity(glowOpacity * 0.3),
                            Color.clear,
                        ],
                        center: .center,
                        startRadius: 20,
                        endRadius: 200
                    )
                )
                .frame(width: 400, height: 400)
                .scaleEffect(glowScale)
                .allowsHitTesting(false)

            // Avatar image
            Image(nsImage: appearance.fullAvatarImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 200, height: 200)
                .clipShape(Circle())
                .shadow(color: Meadow.avatarGradientStart.opacity(0.3), radius: 12)
                .scaleEffect(avatarScale)
                .opacity(avatarOpacity)
        }
        .onAppear {
            startAnimation()
        }
        .accessibilityHidden(true)
    }

    // MARK: - Animation Sequence

    private func startAnimation() {
        // 1. Avatar bouncy entrance
        withAnimation(VAnimation.bouncy) {
            avatarScale = 1.0
            avatarOpacity = 1.0
        }

        // 2. Glow pulse starts slightly after avatar begins
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            withAnimation(.easeOut(duration: 0.8)) {
                glowScale = 1.6
                glowOpacity = 0.5
            }
            // Fade glow out
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                glowOpacity = 0.0
            }
        }

        // 3. Notify completion
        DispatchQueue.main.asyncAfter(deadline: .now() + completionDelay) {
            onComplete()
        }
    }
}
