import SwiftUI
import VellumAssistantShared

@MainActor
struct EmailVerificationView: View {
    @Bindable var authManager: AuthManager
    @State private var verificationKey = ""
    @State private var hasSentReset = false

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.xs) {
                Image(systemName: "envelope.badge")
                    .font(.system(size: 36))
                    .foregroundColor(VColor.accent)

                Text("Check your email")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)

                if let email = authManager.pendingVerificationEmail {
                    Text("We sent a verification link to **\(email)**.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.center)
                } else {
                    Text("Enter the verification key from your email.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }

            VStack(spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Verification key")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    VTextField(placeholder: "Paste verification key", text: $verificationKey) {
                        submit()
                    }
                }

                VButton(
                    label: authManager.isSubmitting ? "Verifying..." : "Verify email",
                    style: .primary,
                    isFullWidth: true,
                    isDisabled: authManager.isSubmitting || verificationKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    submit()
                }
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
            }

            if hasSentReset {
                Text("A new verification email has been sent.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.success)
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
        let trimmed = verificationKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task { await authManager.verifyEmail(key: trimmed) }
    }
}

#if DEBUG
struct EmailVerificationView_Preview: PreviewProvider {
    static var previews: some View {
        EmailVerificationPreviewWrapper()
            .frame(width: 500, height: 500)
            .previewDisplayName("EmailVerificationView")
    }
}

private struct EmailVerificationPreviewWrapper: View {
    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            EmailVerificationView(authManager: AuthManager())
        }
    }
}
#endif
