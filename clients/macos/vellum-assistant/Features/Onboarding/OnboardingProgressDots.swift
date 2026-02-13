import SwiftUI

/// Five cumulative progress dots for the onboarding flow.
///
/// By default maps 7 steps (0-6) to 5 dots. Pass a custom `totalSteps`
/// for flows with a different number of steps (e.g. `totalSteps: 5` for
/// the first-meeting flow).
struct OnboardingProgressDots: View {
    let currentStep: Int
    let totalSteps: Int

    private let totalDots = 5

    init(currentStep: Int, totalSteps: Int = 7) {
        self.currentStep = currentStep
        self.totalSteps = totalSteps
    }

    /// Maps the current step to the active dot index (0 ..< totalDots)
    /// by evenly distributing `totalSteps` across `totalDots`.
    private var activeDotIndex: Int {
        guard totalSteps > 1 else { return 0 }
        let fraction = Double(currentStep) / Double(totalSteps - 1)
        return min(Int(fraction * Double(totalDots - 1) + 0.5), totalDots - 1)
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(0..<totalDots, id: \.self) { index in
                Circle()
                    .fill(index <= activeDotIndex ? VColor.textPrimary : VColor.textMuted.opacity(0.3))
                    .frame(
                        width: index == activeDotIndex ? 8 : 6,
                        height: index == activeDotIndex ? 8 : 6
                    )
                    .animation(.spring(duration: 0.4, bounce: 0.2), value: activeDotIndex)
            }
        }
    }
}

#Preview {
    ZStack {
        VColor.background
        VStack(spacing: 20) {
            OnboardingProgressDots(currentStep: 0)
            OnboardingProgressDots(currentStep: 2)
            OnboardingProgressDots(currentStep: 5)
        }
    }
    .frame(width: 200, height: 100)
}
