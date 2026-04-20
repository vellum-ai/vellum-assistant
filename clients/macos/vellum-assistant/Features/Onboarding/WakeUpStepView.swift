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

    @State private var showCards = false
    @State private var isAdvancedExpanded: Bool = false

    // MARK: - Body

    var body: some View {
        VStack(spacing: VSpacing.md) {
            if managedSignInEnabled {
                OnboardingVellumCloudCard(
                    isLoading: authManager?.isLoading == true || authManager?.isSubmitting == true,
                    isDisabled: isAdvancing,
                    onContinue: { onContinueWithVellum() }
                )

                OnboardingLocalModeDisclosure(
                    isExpanded: $isAdvancedExpanded,
                    isDisabled: isAdvancing,
                    onUseLocalMode: {
                        state?.skippedAuth = true
                        onStartWithAPIKey()
                    }
                )
            } else {
                // Unchanged fallback
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
        .disabled(isAdvancing || authManager?.isSubmitting == true)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showCards = true
            }
        }
    }
}
