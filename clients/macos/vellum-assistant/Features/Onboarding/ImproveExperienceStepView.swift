import VellumAssistantShared
import SwiftUI

@MainActor
struct ImproveExperienceStepView: View {
    @Bindable var state: OnboardingState

    @State private var showTitle = false
    @State private var showContent = false
    @State private var collectUsageData: Bool = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
    @State private var sharePerformanceMetrics: Bool = UserDefaults.standard.object(forKey: "sendPerformanceReports") as? Bool ?? true

    var body: some View {
        Text("Improve Experience")
            .font(VFont.onboardingTitle)
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Send anonymised performance metrics to help us improve responsiveness. No personal data or message content is included.")
            .font(VFont.onboardingSubtitle)
            .foregroundColor(VColor.contentSecondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

        VStack(spacing: VSpacing.md) {
            HStack {
                Text("Collect usage data")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                Spacer()
                VToggle(isOn: Binding(
                    get: { collectUsageData },
                    set: { newValue in
                        collectUsageData = newValue
                        UserDefaults.standard.set(newValue, forKey: "collectUsageDataEnabled")
                        UserDefaults.standard.set(true, forKey: "collectUsageDataExplicitlySet")
                        if !newValue {
                            sharePerformanceMetrics = false
                            UserDefaults.standard.set(false, forKey: "sendPerformanceReports")
                        }
                    }
                ))
            }

            HStack {
                Text("Share performance metrics")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                Spacer()
                VToggle(isOn: Binding(
                    get: { sharePerformanceMetrics },
                    set: { newValue in
                        sharePerformanceMetrics = newValue
                        UserDefaults.standard.set(newValue, forKey: "sendPerformanceReports")
                    }
                ))
                .disabled(!collectUsageData)
            }
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
                    .foregroundColor(VColor.contentTertiary)
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
            if UserDefaults.standard.object(forKey: "collectUsageDataEnabled") == nil {
                UserDefaults.standard.set(true, forKey: "collectUsageDataEnabled")
            }
            if UserDefaults.standard.object(forKey: "sendPerformanceReports") == nil {
                UserDefaults.standard.set(true, forKey: "sendPerformanceReports")
            }

            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }

        OnboardingFooter(currentStep: state.currentStep, totalSteps: 3)
            .padding(.bottom, VSpacing.lg)
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }
}
