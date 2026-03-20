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
    @State private var collectUsageData: Bool = UserDefaults.standard.object(forKey: "collectUsageData") as? Bool ?? true
    @State private var sendDiagnostics: Bool = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool ?? true
    @State private var tosAccepted: Bool = UserDefaults.standard.bool(forKey: "tosAccepted")

    var body: some View {
        Text("Before You Start")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Choose your privacy preferences.\nYou can update these anytime in Settings.")
            .font(VFont.buttonLarge)
            .multilineTextAlignment(.center)
            .foregroundColor(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                // Privacy toggles card
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
                .padding(VSpacing.lg)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )

                // ToS consent checkbox
                HStack(spacing: VSpacing.md) {
                    VCheckbox(isOn: $tosAccepted)
                    tosConsentText
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.lg)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )

                OnboardingButton(
                    title: "Accept and Start",
                    style: .primary,
                    disabled: !tosAccepted
                ) {
                    saveAndContinue()
                }

                OnboardingButton(title: "Back", style: .ghost) {
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

    // MARK: - ToS Consent Text

    private var tosConsentText: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(.init("I agree to the [Terms of Service](https://www.vellum.ai/docs/vellum-terms-of-use) and [Privacy Policy](https://www.vellum.ai/docs/privacy-policy)"))
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

// MARK: - Checkbox

/// A styled checkbox matching the V* component aesthetic: primary-filled with
/// white checkmark when checked, outlined rounded square when unchecked.
private struct VCheckbox: View {
    @Binding var isOn: Bool

    private let size: CGFloat = 20
    private let cornerRadius: CGFloat = VRadius.sm

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            ZStack {
                if isOn {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(VColor.primaryBase)

                    VIconView(.check, size: 12)
                        .foregroundColor(VColor.auxWhite)
                } else {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(Color.clear)
                        .overlay(
                            RoundedRectangle(cornerRadius: cornerRadius)
                                .stroke(VColor.borderBase, lineWidth: 1.5)
                        )
                }
            }
            .frame(width: size, height: size)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(VAnimation.fast, value: isOn)
        .accessibilityLabel("Agree to Terms of Service and Privacy Policy")
        .accessibilityValue(isOn ? "Checked" : "Unchecked")
        .accessibilityAddTraits(.isToggle)
    }
}
