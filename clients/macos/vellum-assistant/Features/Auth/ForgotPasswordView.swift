import SwiftUI
import VellumAssistantShared

@MainActor
struct ForgotPasswordView: View {
    @Bindable var authManager: AuthManager
    @State private var email = ""
    @State private var hasSent = false

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.xs) {
                Text("Reset your password")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
                Text("Enter your email and we'll send you a reset link.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Email")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    VTextField(placeholder: "you@example.com", text: $email, leadingIcon: "envelope") {
                        submit()
                    }
                }

                VButton(
                    label: authManager.isSubmitting ? "Sending..." : "Send reset link",
                    style: .primary,
                    isFullWidth: true,
                    isDisabled: authManager.isSubmitting || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    submit()
                }
            }

            if hasSent {
                Text("If an account exists with that email, a reset link has been sent.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.success)
                    .multilineTextAlignment(.center)
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
            }

            Button {
                authManager.errorMessage = nil
                authManager.currentFlow = .login
            } label: {
                Text("Back to sign in")
                    .font(VFont.caption)
                    .foregroundColor(VColor.accent)
            }
            .buttonStyle(.plain)
        }
        .padding(VSpacing.xxl)
        .frame(width: 380)
    }

    private func submit() {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        hasSent = false
        Task {
            await authManager.requestPasswordReset(email: trimmed)
            if authManager.errorMessage == nil {
                hasSent = true
            }
        }
    }
}

#if DEBUG
struct ForgotPasswordView_Preview: PreviewProvider {
    static var previews: some View {
        ForgotPasswordPreviewWrapper()
            .frame(width: 500, height: 400)
            .previewDisplayName("ForgotPasswordView")
    }
}

private struct ForgotPasswordPreviewWrapper: View {
    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            ForgotPasswordView(authManager: AuthManager())
        }
    }
}
#endif
