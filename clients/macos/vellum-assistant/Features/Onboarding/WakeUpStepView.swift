import VellumAssistantShared
import SwiftUI

@MainActor
struct WakeUpStepView: View {
    // MARK: - Configuration

    /// Optional onboarding state. When nil the view works standalone (e.g. auth gate).
    var state: OnboardingState?

    /// Optional auth manager for showing loading/error state on the login button.
    var authManager: AuthManager?

    /// When true, disables all buttons (e.g. during 0.3s advance delay).
    var isAdvancing: Bool = false

    /// When true, the managed sign-in Vellum Cloud card + Advanced disclosure
    /// are rendered. When false, the primary action is a single "Get Started"
    /// button that advances directly.
    var managedSignInEnabled: Bool = false

    // Callbacks
    var onStartWithAPIKey: () -> Void = {}
    var onContinueWithVellum: () -> Void = {}

    // MARK: - Private State

    @State private var showTitle = false
    @State private var showSubtext = false
    @State private var showCloudCard = false
    @State private var showDisclosure = false
    @State private var showCharacters = false
    @State private var isAdvancedExpanded: Bool = false

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    // MARK: - Body

    var body: some View {
        // Title
        Text("Welcome to Vellum")
            .font(VFont.titleLarge)
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xs)

        // Subtitle
        Text("The safest way to create your personal assistant.")
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentSecondary)
            .multilineTextAlignment(.center)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        // Setup-option cards (managed path) or single "Get Started" fallback.
        // The two cards animate in separately (cloud first, then the
        // disclosure) so the primary option anchors the user's attention
        // before the secondary one slides in underneath.
        VStack(spacing: VSpacing.xs) {
            if managedSignInEnabled {
                OnboardingVellumCloudCard(
                    isLoading: authManager?.isLoading == true,
                    isSubmitting: authManager?.isSubmitting == true,
                    isDisabled: isAdvancing,
                    onContinue: { onContinueWithVellum() }
                )
                .opacity(showCloudCard ? 1 : 0)
                .offset(y: showCloudCard ? 0 : 12)

                OnboardingLocalModeDisclosure(
                    isExpanded: $isAdvancedExpanded,
                    isDisabled: isAdvancing
                        || authManager?.isLoading == true
                        || authManager?.isSubmitting == true,
                    onUseLocalMode: {
                        state?.skippedAuth = true
                        onStartWithAPIKey()
                    }
                )
                .opacity(showDisclosure ? 1 : 0)
                .offset(y: showDisclosure ? 0 : 12)
            } else {
                VButton(label: "Get Started", style: .primary, isFullWidth: true) {
                    onStartWithAPIKey()
                }
                .opacity(showCloudCard ? 1 : 0)
                .offset(y: showCloudCard ? 0 : 12)
            }

            if let error = authManager?.errorMessage {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, VSpacing.xl)
        .disabled(
            isAdvancing
                || authManager?.isLoading == true
                || authManager?.isSubmitting == true
        )
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showSubtext = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                showCloudCard = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.65)) {
                showDisclosure = true
            }
        }

        Spacer(minLength: VSpacing.md)

        Text("2026 Vellum Inc.")
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentTertiary)
            .padding(.bottom, VSpacing.xs)

        // Characters peeking up from the bottom. Rendered at the
        // illustration's natural aspect (4:1 → ~110pt tall at 440pt
        // window width) so the piece is never cropped. If the Advanced
        // disclosure is expanded, the step content exceeds the 630pt
        // window envelope and the outer ScrollView in OnboardingFlowView
        // engages — deliberate trade so the footer stays intact on the
        // default collapsed landing view.
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
                .animation(.easeOut(duration: 0.6).delay(0.8), value: showCharacters)
                .onAppear { showCharacters = true }
                .accessibilityHidden(true)
        }
    }
}
