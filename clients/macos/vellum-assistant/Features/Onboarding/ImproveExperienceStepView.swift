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
    @State private var showCharacters = false

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()
    @AppStorage("collectUsageData") private var collectUsageData: Bool = true
    @AppStorage("sendDiagnostics") private var sendDiagnostics: Bool = true
    @AppStorage("tosAccepted") private var tosAccepted: Bool = false

    var body: some View {
        Text("Before You Start")
            .font(VFont.titleLarge)
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Choose your privacy preferences. You can update these anytime in the Settings.")
            .font(VFont.bodyMediumLighter)
            .multilineTextAlignment(.center)
            .foregroundStyle(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.horizontal, VSpacing.xxl)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: 0) {
            VStack(spacing: VSpacing.sm) {
                // Usage analytics toggle
                VToggle(
                    isOn: $collectUsageData,
                    label: "Share Analytics",
                    helperText: "Send anonymous product usage data."
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(VColor.surfaceLift)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.lg)
                                .stroke(VColor.surfaceBase, lineWidth: 1)
                        )
                )

                // Diagnostics toggle
                VToggle(
                    isOn: $sendDiagnostics,
                    label: "Share Diagnostics",
                    helperText: "Send crash reports and performance metrics."
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(VColor.surfaceLift)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.lg)
                                .stroke(VColor.surfaceBase, lineWidth: 1)
                        )
                )

                // Privacy note bar
                HStack(spacing: VSpacing.xs) {
                    VIconView(.eyeOff, size: 14)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("Your conversations and personal data are never included.")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .padding(.bottom, VSpacing.sm)

                // ToS consent checkbox
                HStack(spacing: VSpacing.md) {
                    tosCheckbox
                    tosConsentText
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            VStack(spacing: VSpacing.sm) {
                VButton(label: "Start", style: .primary, isFullWidth: true, isDisabled: !tosAccepted) {
                    saveAndContinue()
                }

                VButton(label: "Back", style: .outlined, isFullWidth: true) {
                    goBack()
                }
            }
            .padding(.top, VSpacing.xxl)
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

        Spacer()

        if let characters = Self.welcomeCharacters {
            Image(nsImage: characters)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(UnevenRoundedRectangle(
                    topLeadingRadius: 0,
                    bottomLeadingRadius: VRadius.window,
                    bottomTrailingRadius: VRadius.window,
                    topTrailingRadius: 0
                ))
                .opacity(showCharacters ? 1 : 0)
                .offset(y: showCharacters ? 0 : 30)
                .animation(.easeOut(duration: 0.6).delay(0.5), value: showCharacters)
                .onAppear { showCharacters = true }
                .accessibilityHidden(true)
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
        let markdown = "I agree to the [Terms of Service](\(AppURLs.termsOfUseDocs.absoluteString)) and [Privacy Policy](\(AppURLs.privacyPolicyDocs.absoluteString))"
        // Use `try?` with a plain-text fallback so a markdown parse failure
        // (e.g. unexpected interpolated content from VELLUM_DOCS_BASE_URL) degrades
        // gracefully instead of crashing the onboarding flow.
        guard var str = try? AttributedString(markdown: markdown) else {
            return AttributedString("I agree to the Terms of Service and Privacy Policy")
        }
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
