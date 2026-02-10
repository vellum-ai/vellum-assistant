import SwiftUI

/// Integration wrapper that embeds the egg hatch animation into the onboarding flow.
/// Shows egg during idle/wobble/crack, burst effects during burst, and creature during reveal.
struct OnboardingHatchView: View {
    @Bindable var state: OnboardingState
    @State private var viewModel = HatchViewModel()

    private let scale: CGFloat = 0.35

    var body: some View {
        ZStack {
            // Egg (visible during idle, wobble, crack)
            if viewModel.stage == .idle || viewModel.stage == .wobble || viewModel.stage == .crack {
                EggView(
                    stage: viewModel.stage,
                    crackLevel: viewModel.crackLevel,
                    onTap: { viewModel.handleEggTap() }
                )
            }

            // Burst effects
            if viewModel.stage == .burst {
                ShellPieces(visible: true)
                EnergyRing(visible: true)
                BurstSparkles(visible: true)
                WhiteFlash(visible: true)
            }

            // Reveal
            if viewModel.stage == .reveal {
                CreatureView(visible: true)
                RevealSparkles(visible: true)
            }
        }
        .scaleEffect(scale)
        .frame(width: 200, height: 180)
        .clipped()
        .onAppear {
            // Wire the hatch trigger so WakeUpStepView can start the animation
            state.hatchTrigger = { [viewModel] in
                viewModel.handleEggTap()
            }
            // Wire completion to advance onboarding
            viewModel.onComplete = {
                state.hasHatched = true
                // Delay advance so the creature is visible in OnboardingHatchView
                // before SwiftUI swaps to the standalone CreatureView at step 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    state.advance()
                }
            }
        }
    }
}
