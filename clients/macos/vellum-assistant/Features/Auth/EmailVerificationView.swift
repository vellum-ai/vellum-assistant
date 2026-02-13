import SwiftUI

@MainActor
struct EmailVerificationView: View {
    @Bindable var authManager: AuthManager
    @State private var verificationKey = ""

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Image(systemName: "envelope.badge")
                .font(.system(size: 40))
                .foregroundColor(VColor.accent)

            VStack(spacing: VSpacing.xs) {
                Text("Verify your email")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)

                if let email = authManager.pendingVerificationEmail {
                    Text("We sent a verification link to **\(email)**. Enter the verification key from the email below.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.center)
                } else {
                    Text("Enter the verification key from the email we sent you.")
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
                    VTextField(
                        placeholder: "Paste your verification key",
                        text: $verificationKey,
                        leadingIcon: "key"
                    ) {
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
#Preview("EmailVerificationView") {
    ZStack {
        VColor.background.ignoresSafeArea()
        EmailVerificationView(authManager: AuthManager())
    }
    .frame(width: 500, height: 500)
}
#endif
