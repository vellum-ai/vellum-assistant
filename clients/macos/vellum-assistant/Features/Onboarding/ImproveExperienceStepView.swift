import VellumAssistantShared
import SwiftUI

@MainActor
struct ImproveExperienceStepView: View {
    @Bindable var state: OnboardingState

    @State private var showTitle = false
    @State private var showContent = false
    @State private var sharePerformanceMetrics: Bool = UserDefaults.standard.object(forKey: "sendPerformanceReports") as? Bool ?? true

    var body: some View {
        Text("Improve Experience")
            .font(VFont.onboardingTitle)
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("To provide you the best experience, your assistant will ask you a couple of questions to get to know you better.")
            .font(VFont.onboardingSubtitle)
            .foregroundColor(VColor.textSecondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

        HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Share performance metrics")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Text("Send anonymised performance metrics to help us improve responsiveness. No personal data or message content is included.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            Spacer()
            VToggle(isOn: Binding(
                get: { sharePerformanceMetrics },
                set: { newValue in
                    sharePerformanceMetrics = newValue
                    UserDefaults.standard.set(newValue, forKey: "sendPerformanceReports")
                }
            ))
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.top, VSpacing.xl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)

        Spacer()

        VStack(spacing: VSpacing.md) {
            OnboardingButton(
                title: "Continue",
                style: .primary
            ) {
                state.isHatching = true
            }

            Button(action: { goBack() }) {
                Text("Back")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .pointerCursor()
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            // Opt in by default during onboarding, but preserve any existing choice
            if UserDefaults.standard.object(forKey: "sendPerformanceReports") == nil {
                UserDefaults.standard.set(true, forKey: "sendPerformanceReports")
            }

            // Reset stale cloud provider when the user didn't go through CloudCredentials
            // (e.g., user_hosted_enabled was turned off after a previous session set cloudProvider to "aws").
            // Preserve "docker" since Docker users intentionally chose that path.
            if !state.needsCloudCredentials && state.cloudProvider != "local" && state.cloudProvider != "docker" {
                state.cloudProvider = "local"
            }

            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }

        OnboardingFooter(currentStep: state.currentStep, totalSteps: state.needsCloudCredentials ? 4 : 3)
            .padding(.bottom, VSpacing.lg)
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }
}

#Preview("ImproveExperienceStepView") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ImproveExperienceStepView(state: {
            let s = OnboardingState()
            s.currentStep = 1
            return s
        }())
    }
    .frame(width: 520, height: 500)
}
