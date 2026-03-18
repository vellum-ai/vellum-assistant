import SwiftUI
import VellumAssistantShared

/// Displays the correct stage PNG for the current onboarding step
/// with Pokemon-style hatch animations: shaking, white flash, glow.
struct OnboardingStageImage: View {
    let currentStep: Int

    @State private var bobOffset: CGFloat = 0
    @State private var shakeOffset: CGFloat = 0
    @State private var shakeRotation: Double = 0
    @State private var flashOpacity: Double = 0
    @State private var glowOpacity: Double = 0
    @State private var glowScale: CGFloat = 1.0
    @State private var displayedStage: Int = 1
    @State private var isTransitioning = false

    /// Maps onboarding step (0-7) to stage image number (1-5).
    private var stageNumber: Int {
        switch currentStep {
        case 0, 1, 2: return 1
        case 3:       return 2
        case 4, 5:    return 3
        case 6:       return 4
        default:      return 5
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear

            ZStack {
                // Glow behind the sprite
                Ellipse()
                    .fill(
                        RadialGradient(
                            colors: [VColor.auxWhite.opacity(0.6), VColor.auxWhite.opacity(0.0)],
                            center: .center,
                            startRadius: 10,
                            endRadius: 100
                        )
                    )
                    .frame(width: 200, height: 120)
                    .scaleEffect(glowScale)
                    .opacity(glowOpacity)
                    .offset(y: 20) // center glow on sprite body
                    .blur(radius: 8)

                // Stage sprite
                if let url = ResourceBundle.bundle.url(forResource: "stage-\(displayedStage)", withExtension: "png"),
                   let nsImage = NSImage(contentsOf: url) {
                    Image(nsImage: nsImage)
                        .interpolation(.none)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxHeight: 180)
                        .id(displayedStage)
                        .transition(
                            .asymmetric(
                                insertion: .scale(scale: 1.08).combined(with: .opacity),
                                removal: .scale(scale: 0.92).combined(with: .opacity)
                            )
                        )
                }
            }
            .offset(x: shakeOffset, y: bobOffset - 40)
            .animation(
                .easeInOut(duration: 2.5).repeatForever(autoreverses: true),
                value: bobOffset
            )
            .rotationEffect(.degrees(shakeRotation))

            // White flash overlay
            Rectangle()
                .fill(VColor.auxWhite)
                .opacity(flashOpacity)
        }
        .onAppear {
            displayedStage = stageNumber
            // Defer the bob animation start to the next run-loop iteration
            // so the repeatForever .animation() modifier doesn't infect
            // the displayedStage change above. When onboarding resumes
            // from persisted progress, both assignments would otherwise
            // happen in the same SwiftUI update cycle, letting the
            // repeat-forever animation leak to the stage transition.
            DispatchQueue.main.async {
                bobOffset = -4
            }
        }
        .onChange(of: stageNumber) { oldStage, newStage in
            guard oldStage != newStage, !isTransitioning else { return }
            playHatchTransition(to: newStage)
        }
    }

    // MARK: - Animations

    private func playHatchTransition(to newStage: Int) {
        isTransitioning = true

        // Phase 1: Subtle shake — gentle wobble
        let shakeDuration = 0.08
        let shakeSequence = [
            (offset: CGFloat(2), rotation: 1.0),
            (offset: CGFloat(-2), rotation: -1.0),
            (offset: CGFloat(3), rotation: 1.5),
            (offset: CGFloat(-3), rotation: -1.5),
            (offset: CGFloat(2), rotation: 1.0),
            (offset: CGFloat(-2), rotation: -1.0),
            (offset: CGFloat(0), rotation: 0.0),
        ]

        for (index, shake) in shakeSequence.enumerated() {
            let delay = Double(index) * shakeDuration
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                withAnimation(.linear(duration: shakeDuration)) {
                    shakeOffset = shake.offset
                    shakeRotation = shake.rotation
                }
            }
        }

        // Phase 2: Glow builds during shake
        let shakeEnd = Double(shakeSequence.count) * shakeDuration
        withAnimation(.easeIn(duration: shakeEnd)) {
            glowOpacity = 0.4
            glowScale = 1.15
        }

        // Phase 3: White flash + swap sprite
        DispatchQueue.main.asyncAfter(deadline: .now() + shakeEnd) {
            // Brief flash in
            withAnimation(.easeIn(duration: 0.1)) {
                flashOpacity = 0.3
            }

            // Swap sprite at peak flash
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                withAnimation(.spring(duration: 0.5, bounce: 0.2)) {
                    displayedStage = newStage
                }

                // Flash out
                withAnimation(.easeOut(duration: 0.2)) {
                    flashOpacity = 0
                }

                // Glow pulse then fade
                withAnimation(.easeOut(duration: 0.3)) {
                    glowScale = 1.3
                    glowOpacity = 0.6
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    withAnimation(.easeOut(duration: 0.5)) {
                        glowOpacity = 0
                        glowScale = 1.0
                    }
                }

                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    isTransitioning = false
                }
            }
        }
    }
}
