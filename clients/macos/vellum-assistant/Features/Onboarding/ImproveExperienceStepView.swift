import VellumAssistantShared
import SwiftUI

@MainActor
struct ImproveExperienceStepView: View {
    @Bindable var state: OnboardingState

    @State private var showTitle = false
    @State private var showContent = false
    @State private var sharePerformanceMetrics: Bool = true

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            VStack(spacing: VSpacing.md) {
                Text("Improve Experience")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("To provide you the best experience, your assistant will ask you a couple of questions to get to know you better.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)

            VStack(spacing: VSpacing.md) {
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

                OnboardingButton(
                    title: "Continue",
                    style: .primary
                ) {
                    state.isHatching = true
                }

                Button(action: { goBack() }) {
                    Text("Back")
                        .font(.system(size: 13))
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)
        }
        .padding(.horizontal, VSpacing.xxl)
        .onAppear {
            // Opt in by default during onboarding
            UserDefaults.standard.set(true, forKey: "sendPerformanceReports")

            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }
}

#Preview {
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
