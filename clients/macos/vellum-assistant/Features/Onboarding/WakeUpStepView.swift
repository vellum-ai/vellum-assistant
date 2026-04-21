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

    @State private var showIcon = false
    @State private var showTitle = false
    @State private var showSubtext = false
    @State private var showCloudCard = false
    @State private var showDisclosure = false
    @State private var showCharacters = false
    @State private var isAdvancedExpanded: Bool = false

    // MARK: - Assets

    private static let appIcon: NSImage? = {
        guard let path = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png") else { return nil }
        return NSImage(contentsOfFile: path)
    }()

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    // MARK: - Body

    var body: some View {
        // Three-region stack:
        //   • header   — intrinsic height (app icon + title + subtitle)
        //   • middle   — flexible; hosts the setup cards, centered when collapsed
        //   • footer   — intrinsic height (copyright + edge-to-edge characters)
        //
        // Two `Spacer(minLength: 0)` bookends around the cards make the cards
        // float to vertical center inside the middle region when the Advanced
        // disclosure is collapsed, and compress to zero when it expands — the
        // middle region then hands every pixel to the cards, letting the
        // layout "rebalance" without growing the window.
        VStack(spacing: 0) {
            header
                .padding(.horizontal, VSpacing.xl)

            Spacer(minLength: 0)

            cards
                .padding(.horizontal, VSpacing.xl)
                .layoutPriority(1)

            Spacer(minLength: 0)

            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(VAnimation.standard, value: isAdvancedExpanded)
        .onAppear(perform: scheduleEntranceAnimations)
    }

    // MARK: - Header region

    private var header: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: VSpacing.md)

            if let icon = Self.appIcon {
                Image(nsImage: icon)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 80, height: 80)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .shadow(color: VColor.auxBlack.opacity(0.15), radius: 1, x: 0, y: 1)
                    .padding(.bottom, VSpacing.sm)
                    .opacity(showIcon ? 1 : 0)
                    .offset(y: showIcon ? 0 : 8)
                    .accessibilityHidden(true)
            }

            Text("Welcome to Vellum")
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentDefault)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)
                .padding(.bottom, VSpacing.xs)

            Text("The safest way to create your personal assistant.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .opacity(showSubtext ? 1 : 0)
                .offset(y: showSubtext ? 0 : 8)
        }
    }

    // MARK: - Cards region

    private var cards: some View {
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
        .disabled(
            isAdvancing
                || authManager?.isLoading == true
                || authManager?.isSubmitting == true
        )
    }

    // MARK: - Footer region

    private var footer: some View {
        VStack(spacing: 0) {
            Text("2026 Vellum Inc.")
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
                .padding(.bottom, VSpacing.xs)
                .opacity(showCharacters ? 1 : 0)

            // Character illustration always renders at its natural aspect
            // (~4:1 → ~110pt tall at the window's 440pt width) so the
            // piece is never cropped. The bottom corners hug the macOS
            // window radius.
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
                    .accessibilityHidden(true)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Entrance animations

    private func scheduleEntranceAnimations() {
        withAnimation(.easeOut(duration: 0.5).delay(0.05)) {
            showIcon = true
        }
        withAnimation(.easeOut(duration: 0.5).delay(0.15)) {
            showTitle = true
        }
        withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
            showSubtext = true
        }
        withAnimation(.easeOut(duration: 0.5).delay(0.45)) {
            showCloudCard = true
        }
        withAnimation(.easeOut(duration: 0.5).delay(0.6)) {
            showDisclosure = true
        }
        withAnimation(.easeOut(duration: 0.6).delay(0.75)) {
            showCharacters = true
        }
    }
}
