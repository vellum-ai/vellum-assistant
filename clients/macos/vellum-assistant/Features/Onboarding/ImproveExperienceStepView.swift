import SwiftUI
import VellumAssistantShared

@MainActor
struct ImproveExperienceStepView: View {
    @Bindable var state: OnboardingState
    /// Whether the user arrived here by skipping step 2 (API key entry).
    /// Captured at init so it reflects the navigation path, not live auth state.
    var skippedAPIKeyEntry: Bool = false

    @State private var showTitle = false
    @State private var showContent = false
    @State private var collectUsageData: Bool = UserDefaults.standard.object(forKey: "collectUsageData") as? Bool ?? true
    @State private var sendDiagnostics: Bool = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool ?? true
    @State private var tosAccepted: Bool = false

    var body: some View {
        Text("Help improve Vellum")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("You can change these settings at any time in Settings > Privacy.")
            .font(.system(size: 16))
            .foregroundColor(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                // Privacy toggles card
                VStack(spacing: VSpacing.lg) {
                    // Usage analytics toggle
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Share usage analytics")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentSecondary)
                            Text("Send anonymized usage metrics (e.g. token counts, feature adoption) to help us improve the product. No personal data or message content is included.")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        Spacer()
                        VToggle(isOn: $collectUsageData)
                    }

                    SettingsDivider()

                    // Diagnostics toggle
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Send diagnostics")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentSecondary)
                            Text("Share crash reports, error diagnostics, and performance metrics (hang rate, responsiveness) to help us improve stability. No personal data or message content is included.")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        Spacer()
                        VToggle(isOn: $sendDiagnostics)
                    }
                }
                .padding(VSpacing.lg)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )

                // ToS consent toggle
                HStack {
                    tosConsentText
                    Spacer()
                    VToggle(isOn: $tosAccepted)
                }
                .padding(VSpacing.lg)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )

                OnboardingButton(
                    title: "Continue",
                    style: .primary,
                    disabled: !tosAccepted
                ) {
                    saveAndContinue()
                }

                Button(action: { goBack() }) {
                    Text("Back")
                        .font(.system(size: 13))
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .padding(.top, VSpacing.xs)
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }
    }

    // MARK: - ToS Consent Text

    private var tosConsentText: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(.init("I agree to the [Terms of Service](https://www.vellum.ai/docs/vellum-terms-of-use)"))
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .tint(VColor.primaryBase)
                .environment(\.openURL, OpenURLAction { url in
                    NSWorkspace.shared.open(url)
                    return .handled
                })
        }
    }

    // MARK: - Actions

    private func saveAndContinue() {
        UserDefaults.standard.set(collectUsageData, forKey: "collectUsageData")
        UserDefaults.standard.set(sendDiagnostics, forKey: "sendDiagnostics")
        UserDefaults.standard.set(true, forKey: "tosAccepted")

        if sendDiagnostics {
            MetricKitManager.startSentry()
        } else {
            MetricKitManager.closeSentry()
        }

        state.isHatching = true
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            // Users who skipped step 2 (API key) go back to step 1
            state.currentStep -= skippedAPIKeyEntry ? 2 : 1
        }
    }
}
