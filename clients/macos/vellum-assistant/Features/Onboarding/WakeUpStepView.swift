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
    @State private var showCards = false
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
            .padding(.bottom, VSpacing.md)

        // Subtitle
        Text("The safest way to create your personal assistant.")
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentSecondary)
            .multilineTextAlignment(.center)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)
            .padding(.bottom, VSpacing.xl)

        // Setup-option cards (managed path) or single "Get Started" fallback.
        VStack(spacing: VSpacing.sm) {
            if managedSignInEnabled {
                OnboardingVellumCloudCard(
                    isLoading: authManager?.isLoading == true,
                    isSubmitting: authManager?.isSubmitting == true,
                    isDisabled: isAdvancing,
                    onContinue: { onContinueWithVellum() }
                )

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
            } else {
                VButton(label: "Get Started", style: .primary, isFullWidth: true) {
                    onStartWithAPIKey()
                }
            }

            if let error = authManager?.errorMessage {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showCards ? 1 : 0)
        .offset(y: showCards ? 0 : 12)
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
                showCards = true
            }
        }

        Spacer(minLength: VSpacing.lg)

        Text("2026 Vellum Inc.")
            .font(VFont.bodySmallDefault)
            .foregroundStyle(VColor.borderElement)
            .padding(.bottom, VSpacing.sm)

        // Characters peeking up from the bottom — single composed image
        // exported from Figma, displayed edge-to-edge at the window bottom.
        // Clip bottom corners to match the macOS window corner radius.
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
                .animation(.easeOut(duration: 0.6).delay(0.7), value: showCharacters)
                .onAppear { showCharacters = true }
                .accessibilityHidden(true)
        }
    }
}
