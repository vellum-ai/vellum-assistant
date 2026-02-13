import SwiftUI

@MainActor
struct ForgotPasswordView: View {
    @Bindable var authManager: AuthManager
    @State private var email = ""
    @State private var submitted = false

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Image(systemName: "lock.rotation")
                .font(.system(size: 40))
                .foregroundColor(VColor.accent)

            VStack(spacing: VSpacing.xs) {
                Text("Reset your password")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)

                if submitted {
                    Text("If an account exists with that email, you'll receive a password reset link shortly.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.center)
                } else {
                    Text("Enter your email address and we'll send you a link to reset your password.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }

            if !submitted {
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
        Task {
            await authManager.requestPasswordReset(email: trimmed)
            if authManager.errorMessage == nil {
                submitted = true
            }
        }
    }
}

#if DEBUG
#Preview("ForgotPasswordView") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ForgotPasswordView(authManager: AuthManager())
    }
    .frame(width: 500, height: 400)
}
#endif
