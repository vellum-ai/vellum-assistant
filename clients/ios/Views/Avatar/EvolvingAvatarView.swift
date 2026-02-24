#if canImport(UIKit)
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
            avatarImageView
                .scaleEffect(x: breatheScaleX, y: breatheScaleY, anchor: .bottom)
                .scaleEffect(appeared ? 1.0 : 0.0, anchor: .bottom)
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
    private var avatarImageView: some View {
        BlobAvatarShape(palette: currentPalette)
            .frame(width: 200, height: 200)
            .shadow(radius: 8)
            .opacity(avatarOpacity)
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

    /// Progressive opacity based on unlock level.
    /// Falls back to a visible baseline so the avatar preview renders even before onboarding
    /// milestones have been recorded (e.g. when opened directly from Settings on iOS).
    private var avatarOpacity: Double {
        let features = evolutionState.unlockedFeatures
        if features.contains(.fullExpression) { return 1.0 }
        if features.contains(.baseBody) { return 0.95 }
        if features.contains(.coreFace) { return 0.85 }
        if features.contains(.eyes) { return 0.75 }
        // Baseline: show at blob-level opacity so the customization panel is never blank
        return 0.6
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

// MARK: - Blob Avatar Shape

/// Draws the blob avatar using SwiftUI Canvas — works cross-platform without AppKit.
/// Colors are driven entirely by the supplied DinoPalette so body/cheek customization
/// is reflected in the live preview.
private struct BlobAvatarShape: View {
    let palette: DinoPalette

    var body: some View {
        Canvas { context, size in
            drawBlob(in: context, size: size)
        }
    }

    private func drawBlob(in context: GraphicsContext, size: CGSize) {
        let centerX = size.width / 2
        let centerY = size.height / 2
        let nominalRadius = min(size.width, size.height) * 0.40

        // Build organic blob path with subtle harmonic variation
        var path = Path()
        let segments = 64
        for i in 0..<segments {
            let angle = CGFloat(i) / CGFloat(segments) * 2.0 * .pi
            let variation: CGFloat = 1.0
                + 0.04 * cos(2.0 * angle + 0.3)
                + 0.03 * sin(3.0 * angle + 1.0)
                + 0.02 * cos(5.0 * angle)
            let r = nominalRadius * variation
            let x = centerX + r * cos(angle)
            let y = centerY + r * sin(angle)
            if i == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        path.closeSubpath()

        // Fill with palette mid shade — mirrors PixelSpriteBuilder.buildBlobNSImage on macOS
        context.fill(path, with: .color(Color(hex: UInt(palette.mid))))

        // Outline stroke using palette outline (darkest body shade)
        context.stroke(
            path,
            with: .color(Color(hex: UInt(palette.outline))),
            lineWidth: max(1.5, nominalRadius * 0.06)
        )

        // Eyes
        let diameter = nominalRadius * 2.0
        let eyeOuterRadius = diameter * 0.10
        let pupilRadius = diameter * 0.055
        let eyeY = centerY + nominalRadius * 0.08
        let eyeSpacing = diameter * 0.18

        for sign: CGFloat in [-1.0, 1.0] {
            let ex = centerX + sign * eyeSpacing

            // White sclera (eyeWhite is always 0xFFFFFF per DinoPalette)
            let scleraRect = CGRect(
                x: ex - eyeOuterRadius,
                y: eyeY - eyeOuterRadius,
                width: eyeOuterRadius * 2,
                height: eyeOuterRadius * 2
            )
            context.fill(Path(ellipseIn: scleraRect), with: .color(.white))
            context.stroke(
                Path(ellipseIn: scleraRect),
                with: .color(Color(hex: UInt(palette.pupil))),
                lineWidth: max(0.8, nominalRadius * 0.03)
            )

            // Pupil using palette pupil color
            let pupilRect = CGRect(
                x: ex - pupilRadius,
                y: eyeY - pupilRadius,
                width: pupilRadius * 2,
                height: pupilRadius * 2
            )
            context.fill(Path(ellipseIn: pupilRect), with: .color(Color(hex: UInt(palette.pupil))))
        }
    }
}

#Preview {
    let state = AvatarEvolutionState()
    state.unlockedFeatures = [.blob, .eyes, .coreFace, .baseBody, .accessories, .fullExpression]
    return EvolvingAvatarView(evolutionState: state)
        .frame(width: 300, height: 300)
        .background(Color.gray.opacity(0.2))
}
#endif
