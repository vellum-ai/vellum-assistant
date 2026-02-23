import SwiftUI
import VellumAssistantShared

/// Renders the blob avatar with progressive evolution based on AvatarEvolutionState.
/// Shows unlock animations when new visual features appear.
struct EvolvingAvatarView: View {
    let evolutionState: AvatarEvolutionState
    var animated: Bool = true

    @State private var appearance = AvatarAppearanceManager.shared

    @State private var appeared = false
    @State private var breatheScaleY: CGFloat = 1.0
    @State private var breatheScaleX: CGFloat = 1.0
    @State private var glowOpacity: Double = 0.0
    @State private var cachedBlobImage: NSImage?
    @State private var cachedPalette: DinoPalette?

    var body: some View {
        ZStack {
            // Glow pulse on new unlock
            if glowOpacity > 0 {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [Meadow.avatarGradientStart.opacity(glowOpacity), .clear],
                            center: .center,
                            startRadius: 40,
                            endRadius: 160
                        )
                    )
                    .frame(width: 320, height: 320)
                    .allowsHitTesting(false)
            }

            // Avatar image with feature-based opacity masking
            avatarImage
                .scaleEffect(x: breatheScaleX, y: breatheScaleY, anchor: .bottom)
                .scaleEffect(appeared ? 1.0 : 0.0, anchor: .bottom)
                .opacity(evolutionState.unlockedFeatures.contains(.blob) ? 1.0 : 0.0)
        }
        .onChange(of: evolutionState.unlockedFeatures.count) { oldCount, newCount in
            if newCount > oldCount {
                triggerUnlockGlow()
            }
        }
        .onAppear {
            if animated {
                withAnimation(.spring(response: 0.6, dampingFraction: 0.5)) {
                    appeared = true
                }
            } else {
                appeared = true
            }
            let breatheDelay: Double = animated ? 0.6 : 0.0
            DispatchQueue.main.asyncAfter(deadline: .now() + breatheDelay) {
                startBreathing()
            }
        }
    }

    @ViewBuilder
    private var avatarImage: some View {
        Image(nsImage: blobImage)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: 400, height: 360)
            .shadow(radius: 8)
            .opacity(avatarOpacity)
            .onChange(of: currentPalette) { _, newPalette in
                rebuildBlobImage(palette: newPalette)
            }
            .onAppear {
                rebuildBlobImage(palette: currentPalette)
            }
    }

    private var blobImage: NSImage {
        cachedBlobImage ?? PixelSpriteBuilder.buildBlobNSImage(pixelSize: Meadow.artPixelSize, palette: currentPalette)
    }

    private func rebuildBlobImage(palette: DinoPalette) {
        guard palette != cachedPalette else { return }
        cachedPalette = palette
        cachedBlobImage = PixelSpriteBuilder.buildBlobNSImage(pixelSize: Meadow.artPixelSize, palette: palette)
    }

    /// Determine palette based on evolution state.
    /// Before baseBody is unlocked, use a muted/default palette.
    /// After baseBody, use the appearance manager's palette (which reflects LOOKS.md or overrides).
    private var currentPalette: DinoPalette {
        if evolutionState.unlockedFeatures.contains(.baseBody) {
            return appearance.palette
        }
        // Before body color is unlocked, use the default violet palette
        return .violet
    }

    /// Progressive opacity based on unlock level
    private var avatarOpacity: Double {
        let features = evolutionState.unlockedFeatures
        if features.contains(.fullExpression) { return 1.0 }
        if features.contains(.baseBody) { return 0.95 }
        if features.contains(.coreFace) { return 0.85 }
        if features.contains(.eyes) { return 0.75 }
        if features.contains(.blob) { return 0.6 }
        return 0.0
    }

    private func startBreathing() {
        withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) {
            breatheScaleY = 1.03
            breatheScaleX = 0.98
        }
    }

    private func triggerUnlockGlow() {
        withAnimation(.easeIn(duration: 0.3)) {
            glowOpacity = 0.6
        }
        withAnimation(.easeOut(duration: 1.0).delay(0.3)) {
            glowOpacity = 0.0
        }
    }
}
