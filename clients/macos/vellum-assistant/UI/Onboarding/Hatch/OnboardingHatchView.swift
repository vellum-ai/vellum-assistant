import SwiftUI

/// Step-driven egg that progressively cracks as the user advances through onboarding.
/// Each completed step brings the creature closer to hatching, rewarding progress.
struct OnboardingHatchView: View {
    let currentStep: Int
    @Binding var hasHatched: Bool

    @State private var eggStage: HatchStage = .idle
    @State private var crackLevel: Int = 0
    @State private var showBurst = false
    @State private var showCreature = false
    @State private var pulseScale: CGFloat = 1.0

    private let scale: CGFloat = 0.35

    var body: some View {
        ZStack {
            // Egg — visible until burst
            if !showBurst && !showCreature {
                EggView(
                    stage: eggStage,
                    crackLevel: crackLevel,
                    onTap: {}
                )
            }

            // Burst effects
            if showBurst {
                ShellPieces(visible: true)
                EnergyRing(visible: true)
                BurstSparkles(visible: true)
                WhiteFlash(visible: true)
            }

            // Creature reveal
            if showCreature {
                CreatureView(visible: true)
                RevealSparkles(visible: !hasHatched)
            }
        }
        .scaleEffect(scale * pulseScale)
        .frame(width: 200, height: 140)
        .clipped()
        .onAppear {
            if hasHatched {
                showCreature = true
            } else {
                applyStep(currentStep, animated: false)
            }
        }
        .onChange(of: currentStep) { _, newStep in
            guard !hasHatched else { return }

            // Brief pulse — the egg reacts to your action
            withAnimation(.spring(response: 0.2, dampingFraction: 0.5)) {
                pulseScale = 1.08
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                    pulseScale = 1.0
                }
            }

            applyStep(newStep, animated: true)
        }
    }

    // MARK: - Step → Egg State

    private func applyStep(_ step: Int, animated: Bool) {
        switch step {
        case 0:
            // Idle: gentle float, warm glow — inviting
            eggStage = .idle
            crackLevel = 0

        case 1:
            // First sign of life — you named it, it stirs
            eggStage = .wobble
            if animated {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    crackLevel = 1
                }
            } else {
                crackLevel = 1
            }

        case 2:
            // Learning to communicate — wobble intensifies
            eggStage = .wobble
            crackLevel = 2

        case 3:
            // Getting a voice — cracks spread, light seeps through
            eggStage = .wobble
            crackLevel = 3

        case 4:
            // Giving it hands — egg pulses, nearly ready
            eggStage = .crack
            crackLevel = 3

        case 5:
            // Giving it sight — intense glow, about to burst
            eggStage = .crack
            crackLevel = 3

        case 6:
            // It's alive — burst and reveal!
            triggerBurstAndReveal()

        default:
            break
        }
    }

    // MARK: - Burst Sequence

    private func triggerBurstAndReveal() {
        showBurst = true

        // After burst effects play, reveal creature
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            showBurst = false
            showCreature = true
        }

        // Mark hatched after creature settles
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            hasHatched = true
        }
    }
}
