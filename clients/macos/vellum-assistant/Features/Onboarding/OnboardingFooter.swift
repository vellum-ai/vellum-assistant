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
        VStack(spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                ForEach(0..<totalDots, id: \.self) { index in
                    Circle()
                        .fill(index <= activeDotIndex ? Forest._600 : VColor.textMuted.opacity(0.3))
                        .frame(width: 8, height: 8)
                        .animation(.spring(duration: 0.4, bounce: 0.2), value: activeDotIndex)
                }
            }

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
            OnboardingFooter(currentStep: 1)
            OnboardingFooter(currentStep: 2)
        }
    }
    .frame(width: 240, height: 260)
}
