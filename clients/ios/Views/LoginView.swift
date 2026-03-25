#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct LoginView: View {
    @Bindable var authManager: AuthManager
    /// Called after a successful login so the onboarding flow can advance.
    var onContinue: (() -> Void)?
    /// Called when the user cancels or auth fails and they want to go back.
    var onCancel: (() -> Void)?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("✨")
                .font(VFont.onboardingEmoji)

            Text("Log in with Vellum")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.center)

            Text("Sign in to connect to your cloud assistant")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
            }

            Button {
                Task {
                    await authManager.startWorkOSLogin()
                    // Advance once the auth state reflects a successful login.
                    if authManager.isAuthenticated {
                        onContinue?()
                    }
                }
            } label: {
                if authManager.isSubmitting {
                    ProgressView()
                        .tint(.white)
                } else {
                    Text("Sign In")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(authManager.isSubmitting)

            // Allow users to go back if they cancel or can't complete login right now.
            Button("Back") {
                onCancel?()
            }
            .foregroundStyle(VColor.contentSecondary)
            .disabled(authManager.isSubmitting)

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}
#endif
