import SwiftUI

/// Compact dark frosted glass card for onboarding step content.
struct OnboardingPanel<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal, VSpacing.xxl)
            .padding(.vertical, VSpacing.xxxl)
            .frame(maxWidth: 420)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(Meadow.panelBackground)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(Meadow.panelBorder, lineWidth: 1)
                    )
            )
    }
}
