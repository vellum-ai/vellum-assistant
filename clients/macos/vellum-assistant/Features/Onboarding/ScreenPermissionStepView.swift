import VellumAssistantShared
import SwiftUI

@MainActor
struct ScreenPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("Screen access comes later")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)

                Text("Skip screen-recording permission during the first conversation. Start it later from Settings when you explicitly choose computer-control setup.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                    .textSelection(.enabled)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Deferred setup")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)

                Text("Screen Recording requests follow an explicit opt-in flow, not proactive onboarding prompts.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(VSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceBase.opacity(0.3))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase.opacity(0.4), lineWidth: 1)
                    )
            )
            .opacity(showContent ? 1 : 0)

            OnboardingButton(title: "Continue", style: .primary) {
                state.advance()
            }
            .opacity(showContent ? 1 : 0)
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                withAnimation(.easeOut(duration: 0.4)) {
                    showContent = true
                }
            }
        }
    }
}
