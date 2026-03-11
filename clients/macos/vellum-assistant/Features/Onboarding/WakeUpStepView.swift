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

    private var primaryButtonTitle: String {
        onboardingPrimaryButtonTitle(isAuthenticated: authManager?.isAuthenticated == true)
    }

    // MARK: - Body

    var body: some View {
        // Title
        Text("Welcome to Vellum")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xs)

        // Subtitle
        Text("The safest way to create your\npersonal assistant.")
            .font(.system(size: 16))
            .foregroundColor(VColor.textSecondary)
            .multilineTextAlignment(.center)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        // Buttons
        VStack(spacing: VSpacing.sm) {
            if authManager?.isLoading == true {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Checking...")
                        .font(VFont.monoMedium)
                        .foregroundColor(VColor.textSecondary)
                }
                .frame(height: 36)
            } else if authManager?.isSubmitting == true {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Signing in...")
                        .font(VFont.monoMedium)
                        .foregroundColor(VColor.textSecondary)
                }
                .frame(height: 36)
            } else {
                OnboardingButton(title: primaryButtonTitle, style: .primary) {
                    onContinueWithVellum()
                }
                .accessibilityLabel("Sign in")
            }

            OnboardingButton(title: "Self-host", style: .tertiary) {
                onStartWithAPIKey()
            }
            .accessibilityLabel("Self-host")

            // Auth error message
            if let error = authManager?.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
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
            .foregroundStyle(VColor.textMuted.opacity(0.5))
            .padding(.bottom, VSpacing.sm)

        // Characters peeking up from the bottom — single composed image
        // exported from Figma, displayed edge-to-edge at the window bottom.
        if let characters = Self.welcomeCharacters {
            Image(nsImage: characters)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
                .opacity(showCharacters ? 1 : 0)
                .offset(y: showCharacters ? 0 : 30)
                .animation(.easeOut(duration: 0.6).delay(0.7), value: showCharacters)
                .onAppear { showCharacters = true }
                .accessibilityHidden(true)
        }
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
