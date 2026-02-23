import VellumAssistantShared
import SwiftUI

@MainActor
struct WakeUpStepView: View {
    // MARK: - Configuration

    /// Optional onboarding state. When nil the view works standalone (e.g. auth gate).
    var state: OnboardingState?

    /// Optional auth manager for showing loading/error state on the Vellum card.
    var authManager: AuthManager?

    /// When true, disables all option cards (e.g. during 0.3s advance delay).
    var isAdvancing: Bool = false

    // Callbacks
    var onStartWithAPIKey: () -> Void = {}
    var onContinueWithVellum: () -> Void = {}

    /// Whether to show the onboarding footer with progress dots.
    var showFooter: Bool = true

    // MARK: - Private State

    @State private var showTitle = false
    @State private var showSubtext = false
    @State private var showButtons = false
    // MARK: - Body

    var body: some View {
        // Title
        Text("Create your Velly")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        // Subtitle
        Text("The safest way to create your personal assistant.")
            .font(.system(size: 16, design: .monospaced))
            .foregroundColor(VColor.textSecondary)
            .multilineTextAlignment(.center)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)

        // Question prompt
        Text("How would you like to start?")
            .font(.system(size: 16, weight: .medium, design: .monospaced))
            .foregroundColor(VColor.textPrimary)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)
            .padding(.top, VSpacing.xxl)

        // Option cards
        VStack(spacing: VSpacing.lg) {
            HStack(spacing: VSpacing.md) {
                // Card 1: Own API Key
                optionCard(
                    title: "Own API Key",
                    description: "When you already have a subscription to a model.",
                    action: { onStartWithAPIKey() }
                )

                // Card 2: Vellum Account
                optionCard(
                    title: "Vellum Account",
                    description: "Get 30 free credits starting with your Vellum Account without the need for your own model subscription.",
                    isLoading: authManager?.isSubmitting == true,
                    action: { onContinueWithVellum() }
                )
            }
            .padding(.top, VSpacing.xl)

            // Auth error message
            if let error = authManager?.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showButtons ? 1 : 0)
        .offset(y: showButtons ? 0 : 12)
        .disabled(isAdvancing || authManager?.isSubmitting == true)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showSubtext = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                showButtons = true
            }
        }

        if showFooter {
            OnboardingFooter(currentStep: state?.currentStep ?? 0)
                .padding(.bottom, VSpacing.lg)
        }
    }

    // MARK: - Option Card

    @ViewBuilder
    private func optionCard(
        title: String,
        description: String,
        isLoading: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: VSpacing.md) {
            Text(title)
                .font(.system(size: 16, weight: .bold, design: .monospaced))
                .foregroundColor(VColor.textPrimary)

            Text(description)
                .font(.system(size: 13, design: .monospaced))
                .foregroundColor(VColor.textMuted)
                .lineSpacing(3)
                .multilineTextAlignment(.center)

            Spacer()

            if isLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Signing in...")
                        .font(VFont.monoMedium)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                VButton(label: "Start", action: action)
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(adaptiveColor(light: Stone._300.opacity(0.3), dark: Moss._700.opacity(0.4)))
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(VColor.surfaceBorder, lineWidth: 1)
        )
    }
}

// MARK: - Previews

#Preview("Onboarding context") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            Spacer()
            Image("VellyLogo")
                .resizable()
                .interpolation(.none)
                .aspectRatio(contentMode: .fit)
                .frame(width: 128, height: 128)
                .padding(.bottom, VSpacing.xxl)
            WakeUpStepView(state: OnboardingState())
        }
    }
    .frame(width: 520, height: 580)
}

