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
        titleSection

        ScrollView {
            VStack(spacing: VSpacing.xl) {
                nameAndEmailSection
                permissionsSection
                tosConsentSection
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.top, VSpacing.lg)
        }
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)

        Spacer()

        buttonsSection
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)

        OnboardingFooter(currentStep: state.currentStep, totalSteps: state.needsCloudCredentials ? 4 : 3)
            .padding(.bottom, VSpacing.lg)
            .onAppear {
                // Opt in by default during onboarding, but preserve any existing choice
                if UserDefaults.standard.object(forKey: "collectUsageDataEnabled") == nil {
                    UserDefaults.standard.set(true, forKey: "collectUsageDataEnabled")
                }
                if UserDefaults.standard.object(forKey: "sendPerformanceReports") == nil {
                    UserDefaults.standard.set(true, forKey: "sendPerformanceReports")
                }

                // Pre-check ToS if the user has previously accepted
                if OnboardingState.hasAcceptedToS {
                    state.tosAccepted = true
                }

                // Reset stale cloud provider when the user didn't go through CloudCredentials
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
    }

    // MARK: - Title

    @ViewBuilder
    private var titleSection: some View {
        Text("Welcome to Vellum!")
            .font(VFont.onboardingTitle)
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Before we get started, we need to ask you for a few things.")
            .font(VFont.onboardingSubtitle)
            .foregroundColor(VColor.contentSecondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
    }

    // MARK: - Name & Email

    @ViewBuilder
    private var nameAndEmailSection: some View {
        VStack(spacing: VSpacing.md) {
            HStack {
                Text("Your name")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
            }
            VTextField(
                placeholder: "Your name",
                text: $state.userDisplayName,
                leadingIcon: VIcon.user.rawValue
            )
        }

        VStack(spacing: VSpacing.md) {
            HStack {
                Text("Email")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
            }
            VTextField(
                placeholder: "you@example.com",
                text: $state.userEmail,
                leadingIcon: VIcon.mail.rawValue
            )
        }
    }

    // MARK: - Permissions

    @ViewBuilder
    private var permissionsSection: some View {
        VStack(spacing: VSpacing.md) {
            usageDataRow
            performanceMetricsRow
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    @ViewBuilder
    private var usageDataRow: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Usage data")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Text("The app will collect usage data to help us improve it. It will never collect the content of your conversations.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
                HStack(spacing: 0) {
                    Link("Terms of Service", destination: URL(string: "https://vellum.ai/terms")!)
                        .font(VFont.caption)
                        .foregroundColor(VColor.primaryBase)
                    Text(" and ")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                    Link("Privacy Policy.", destination: URL(string: "https://vellum.ai/privacy")!)
                        .font(VFont.caption)
                        .foregroundColor(VColor.primaryBase)
                }
            }
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
    }

    @ViewBuilder
    private var performanceMetricsRow: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Performance metrics")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Text("Share anonymised performance data to help us improve responsiveness. No personal data or message content is included.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
            }
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

    // MARK: - ToS Consent

    @ViewBuilder
    private var tosConsentSection: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Button(action: {
                state.tosAccepted.toggle()
            }) {
                VIconView(state.tosAccepted ? .check : .square, size: 16)
                    .foregroundColor(state.tosAccepted ? VColor.primaryBase : VColor.contentSecondary)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("Accept terms")
            .accessibilityValue(state.tosAccepted ? "Accepted" : "Not accepted")

            tosConsentLabel
        }
    }

    @ViewBuilder
    private var tosConsentLabel: some View {
        HStack(spacing: 0) {
            Text("I agree to the ")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
            Link("Terms of Service", destination: URL(string: "https://vellum.ai/terms")!)
                .font(VFont.caption)
                .foregroundColor(VColor.primaryBase)
            Text(" and ")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
            Link("Privacy Policy", destination: URL(string: "https://vellum.ai/privacy")!)
                .font(VFont.caption)
                .foregroundColor(VColor.primaryBase)
            Text(".")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
        }
    }

    // MARK: - Buttons

    @ViewBuilder
    private var buttonsSection: some View {
        VStack(spacing: VSpacing.md) {
            OnboardingButton(
                title: "Accept and Continue",
                style: .primary,
                disabled: !state.tosAccepted || state.userEmail.isEmpty
            ) {
                UserDefaults.standard.set(state.userDisplayName, forKey: "user.displayName")
                UserDefaults.standard.set(state.userEmail, forKey: "user.email")
                UserDefaults.standard.set(collectUsageData, forKey: "collectUsageDataEnabled")
                UserDefaults.standard.set(sharePerformanceMetrics, forKey: "sendPerformanceReports")
                if state.tosAccepted {
                    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "tos.acceptedAt")
                }
                SentryDeviceInfo.configureUserIdentity()
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
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }
}
