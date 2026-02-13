import SwiftUI

@MainActor
struct SignupView: View {
    @Bindable var authManager: AuthManager
    @State private var email = ""
    @State private var username = ""
    @State private var password = ""
    @State private var passwordConfirm = ""
    @State private var localError: String?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.xs) {
                Text("Create an account")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
                Text("Sign up with your email and password.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: VSpacing.lg) {
                fieldRow(label: "Email") {
                    VTextField(placeholder: "you@example.com", text: $email, leadingIcon: "envelope")
                }

                fieldRow(label: "Username") {
                    VTextField(placeholder: "Choose a username", text: $username, leadingIcon: "person")
                }

                fieldRow(label: "Password") {
                    secureFieldView(placeholder: "Create a password", text: $password)
                }

                fieldRow(label: "Confirm password") {
                    secureFieldView(placeholder: "Confirm your password", text: $passwordConfirm) {
                        submit()
                    }
                }

                VButton(
                    label: authManager.isSubmitting ? "Creating account..." : "Sign up",
                    style: .primary,
                    isFullWidth: true,
                    isDisabled: authManager.isSubmitting || !formValid
                ) {
                    submit()
                }
            }

            if !authManager.providers.isEmpty {
                dividerRow

                VStack(spacing: VSpacing.sm) {
                    ForEach(authManager.providers, id: \.id) { provider in
                        VButton(
                            label: authManager.isSubmitting ? "Redirecting..." : "Continue with \(provider.name ?? provider.id)",
                            style: .ghost,
                            isFullWidth: true,
                            isDisabled: authManager.isSubmitting
                        ) {
                            Task { await authManager.startOIDCLogin(provider: provider) }
                        }
                    }
                }
            }

            if let error = localError ?? authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
            }

            Button {
                authManager.errorMessage = nil
                localError = nil
                authManager.currentFlow = .login
            } label: {
                Text("Already have an account? Sign in")
                    .font(VFont.caption)
                    .foregroundColor(VColor.accent)
            }
            .buttonStyle(.plain)
        }
        .padding(VSpacing.xxl)
        .frame(width: 380)
    }

    private var formValid: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
            && !passwordConfirm.isEmpty
    }

    private var dividerRow: some View {
        HStack(spacing: VSpacing.md) {
            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(height: 1)
            Text("or")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(height: 1)
        }
    }

    private func fieldRow<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
            content()
        }
    }

    private func secureFieldView(placeholder: String, text: Binding<String>, onSubmit: (() -> Void)? = nil) -> some View {
        SecureField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(VFont.body)
            .foregroundColor(VColor.textPrimary)
            .padding(VSpacing.md)
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
            .onSubmit { onSubmit?() }
    }

    private func submit() {
        localError = nil
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedEmail.isEmpty, !trimmedUsername.isEmpty, !password.isEmpty, !passwordConfirm.isEmpty else { return }

        guard password == passwordConfirm else {
            localError = "Passwords do not match."
            return
        }

        authManager.pendingVerificationEmail = trimmedEmail
        Task { await authManager.signup(email: trimmedEmail, username: trimmedUsername, password: password) }
    }
}

#if DEBUG
#Preview("SignupView") {
    ZStack {
        VColor.background.ignoresSafeArea()
        SignupView(authManager: AuthManager())
    }
    .frame(width: 500, height: 700)
}
#endif
