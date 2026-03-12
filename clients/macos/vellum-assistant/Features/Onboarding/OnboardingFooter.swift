import VellumAssistantShared
import SwiftUI

struct OnboardingFooter: View {
    let currentStep: Int
    let totalSteps: Int

    private let totalDots = 3

    init(currentStep: Int, totalSteps: Int = 3) {
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
        Text("\u{00A9} 2026 Vellum Inc.")
            .font(VFont.monoSmall)
            .foregroundStyle(VColor.contentTertiary.opacity(0.5))
    }
}

#Preview {
    ZStack {
        VColor.surfaceOverlay
        VStack(spacing: 24) {
            OnboardingFooter(currentStep: 0)
            OnboardingFooter(currentStep: 1)
            OnboardingFooter(currentStep: 2)
        }
    }
    .frame(width: 240, height: 260)
}
