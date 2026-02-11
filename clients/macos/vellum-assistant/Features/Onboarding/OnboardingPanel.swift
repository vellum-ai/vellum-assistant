import SwiftUI

/// Dark frosted glass panel for the right side of onboarding.
struct OnboardingPanel<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
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

            ScrollView {
                content
                    .padding(VSpacing.xxl)
            }
            .scrollIndicators(.hidden)
        }
        .padding(.vertical, VSpacing.xl)
        .padding(.trailing, VSpacing.xl)
        .padding(.leading, VSpacing.md)
    }
}
