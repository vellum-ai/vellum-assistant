#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct LoginView: View {
    @Bindable var authManager: AuthManager

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("✨")
                .font(VFont.onboardingEmoji)

            Text("Log in with Vellum")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            Text("Sign in to connect to your cloud assistant")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
            }

            Button {
                Task { await authManager.startWorkOSLogin() }
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

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}
#endif
