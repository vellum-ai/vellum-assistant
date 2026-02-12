import SwiftUI

/// Five cumulative progress dots for the onboarding flow (steps 0-6).
struct OnboardingProgressDots: View {
    let currentStep: Int

    private let totalDots = 5

    /// Maps onboarding step (0-6) to active dot index (0-4).
    private var activeDotIndex: Int {
        switch currentStep {
        case 0, 1: return 0
        case 2:    return 1
        case 3:    return 2
        case 4:    return 3
        default:   return 4
        }
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
