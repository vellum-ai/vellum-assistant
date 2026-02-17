import VellumAssistantShared
import SwiftUI

/// Onboarding footer combining progress dots with copyright text.
///
/// Renders a row of filled dots indicating progress through onboarding
/// steps, followed by a "2026 Vellum Inc." copyright label.
struct OnboardingFooter: View {
    let currentStep: Int
    let totalSteps: Int

    private let totalDots = 4

    init(currentStep: Int, totalSteps: Int = 8) {
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
        VStack(spacing: VSpacing.sm) {
            // Progress dots
            HStack(spacing: VSpacing.sm) {
                ForEach(0..<totalDots, id: \.self) { index in
                    Circle()
                        .fill(index <= activeDotIndex ? Violet._600 : VColor.textMuted.opacity(0.3))
                        .frame(width: 8, height: 8)
                        .animation(.spring(duration: 0.4, bounce: 0.2), value: activeDotIndex)
                }
            }

            // Copyright text
            Text("\u{00A9} 2026 Vellum Inc.")
                .font(VFont.monoSmall)
                .foregroundStyle(VColor.textMuted.opacity(0.5))
        }
    }
}

#Preview {
    ZStack {
        VColor.background
        VStack(spacing: 24) {
            OnboardingFooter(currentStep: 0)
            OnboardingFooter(currentStep: 2)
            OnboardingFooter(currentStep: 4)
            OnboardingFooter(currentStep: 7)
        }
    }
    .frame(width: 240, height: 260)
}
