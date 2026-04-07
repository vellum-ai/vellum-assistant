import SwiftUI
import VellumAssistantShared

@MainActor
struct ImproveExperienceStepView: View {
    @Bindable var state: OnboardingState
    /// Whether the user arrived here by skipping step 2 (API key entry).
    /// Captured at init so it reflects the navigation path, not live auth state.
    var skippedAPIKeyEntry: Bool = false
    /// Optional override for what happens after the user accepts ToS.
    /// When provided, called instead of the default `state.isHatching = true`.
    var onAccepted: (() -> Void)?

    @State private var showTitle = false
    @State private var showContent = false
    @AppStorage("collectUsageData") private var collectUsageData: Bool = true
    @AppStorage("sendDiagnostics") private var sendDiagnostics: Bool = true
    @AppStorage("tosAccepted") private var tosAccepted: Bool = false

    var body: some View {
        Text("Before You Start")
            .font(VFont.displayLarge)
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Choose your privacy preferences.\nYou can update these anytime in Settings.")
            .font(VFont.titleSmall)
            .multilineTextAlignment(.center)
            .foregroundStyle(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                // Privacy toggles card
                VCard {
                    VStack(spacing: VSpacing.lg) {
                        // Usage analytics toggle
                        VToggle(
                            isOn: $collectUsageData,
                            label: "Share Analytics",
                            helperText: "Send anonymous product usage data. Your conversations and personal data are never included."
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)

                        SettingsDivider()

                        // Diagnostics toggle
                        VToggle(
                            isOn: $sendDiagnostics,
                            label: "Share Diagnostics",
                            helperText: "Send crash reports and performance metrics. Your conversations and personal data are never included."
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                // ToS consent checkbox
                VCard {
                    HStack(spacing: VSpacing.md) {
                        tosCheckbox
                        tosConsentText
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                VButton(label: "Accept and Start", style: .primary, isFullWidth: true, isDisabled: !tosAccepted) {
                    saveAndContinue()
                }

                VButton(label: "Back", style: .ghost) {
                    goBack()
                }
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

    // MARK: - ToS Consent Checkbox

    private var tosCheckbox: some View {
        Button {
            withAnimation(VAnimation.fast) {
                tosAccepted.toggle()
            }
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(tosAccepted ? VColor.primaryBase : Color.clear)

                RoundedRectangle(cornerRadius: VRadius.sm)
                    .strokeBorder(tosAccepted ? Color.clear : VColor.borderElement, lineWidth: 1.5)

                if tosAccepted {
                    VIconView(.check, size: 12)
                        .foregroundStyle(VColor.contentInset)
                }
            }
            .frame(width: 20, height: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Agree to Terms of Service and Privacy Policy")
        .accessibilityValue(tosAccepted ? "Checked" : "Unchecked")
        .accessibilityAddTraits(.isToggle)
    }

    // MARK: - ToS Consent Text

    private var tosConsentText: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(tosAttributedString)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .tint(VColor.primaryBase)
                .environment(\.openURL, OpenURLAction { url in
                    NSWorkspace.shared.open(url)
                    return .handled
                })
        }
    }

    private var tosAttributedString: AttributedString {
        // swiftlint:disable:next force_try
        var str = try! AttributedString(
            markdown: "I agree to the [Terms of Service](https://www.vellum.ai/docs/vellum-terms-of-use) and [Privacy Policy](https://www.vellum.ai/docs/privacy-policy)"
        )
        for run in str.runs where run.link != nil {
            str[run.range].underlineStyle = .single
        }
        return str
    }

    // MARK: - Actions

    private func saveAndContinue() {
        // @AppStorage already persists collectUsageData, sendDiagnostics, and
        // tosAccepted. Explicitly set tosAccepted = true here as a safeguard
        // so acceptance is recorded even if the user somehow bypasses the toggle.
        tosAccepted = true

        if sendDiagnostics {
            MetricKitManager.startSentry()
        } else {
            MetricKitManager.closeSentry()
        }

        if let onAccepted {
            onAccepted()
        } else {
            state.isHatching = true
        }
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            // Users who skipped step 2 (API key) go back to step 1
            state.currentStep -= skippedAPIKeyEntry ? 2 : 1
        }
    }
}
