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

    /// When true, the primary action triggers managed sign-in ("Log In").
    /// When false, the primary action is "Get Started" and advances directly.
    var managedSignInEnabled: Bool = false

    // Callbacks
    var onStartWithAPIKey: () -> Void = {}
    var onContinueWithVellum: () -> Void = {}

    // MARK: - Private State

    @State private var showTitle = false
    @State private var showSubtext = false
    @State private var showButtons = false
    @State private var showCharacters = false

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    // MARK: - Body

    var body: some View {
        // Title
        Text("Welcome to Vellum")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        // Subtitle
        Text("Your personal AI assistant,\nrunning on your terms.")
            .font(.system(size: 16))
            .foregroundColor(VColor.contentSecondary)
            .multilineTextAlignment(.center)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        Color.clear.frame(height: VSpacing.xxl)

        // Buttons
        VStack(spacing: VSpacing.md) {
            if authManager?.isLoading == true {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Checking...")
                        .font(.system(size: 16))
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(height: 36)
            } else if authManager?.isSubmitting == true {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Logging in...")
                        .font(.system(size: 16))
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(height: 36)
            } else if managedSignInEnabled {
                OnboardingButton(title: "Log In", style: .primary) {
                    onContinueWithVellum()
                }
                .accessibilityLabel("Log In")

                OnboardingButton(title: "Continue without account", style: .ghost) {
                    state?.skippedAuth = true
                    onStartWithAPIKey()
                }
                .accessibilityLabel("Continue without account")
            } else {
                OnboardingButton(title: "Get Started", style: .primary) {
                    onStartWithAPIKey()
                }
                .accessibilityLabel("Get Started")
            }

            // Auth error message
            if let error = authManager?.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: 280)
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

        Spacer()

        Text("\u{00A9} 2026 Vellum Inc.")
            .font(VFont.monoSmall)
            .foregroundStyle(VColor.contentTertiary.opacity(0.5))
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
