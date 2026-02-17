import SwiftUI
import VellumAssistantShared

@MainActor
struct LoginView: View {
    @Bindable var authManager: AuthManager
    var onBack: (() -> Void)? = nil
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.xs) {
                Text("Welcome back")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
                Text("Sign in to your Vellum account.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Email")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    VTextField(placeholder: "you@example.com", text: $email, leadingIcon: "envelope")
                }

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Password")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    SecureField("Enter your password", text: $password)
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
                        .onSubmit { submit() }
                }

                VButton(
                    label: authManager.isSubmitting ? "Signing in..." : "Sign in",
                    style: .primary,
                    isFullWidth: true,
                    isDisabled: authManager.isSubmitting || email.isEmpty || password.isEmpty
                ) {
                    submit()
                }
            }

            if !authManager.providers.isEmpty {
                dividerRow

                VStack(spacing: VSpacing.sm) {
                    ForEach(authManager.providers, id: \.id) { provider in
                        let isActiveProvider = authManager.submittingProviderId == provider.id
                        VButton(
                            label: isActiveProvider ? "Redirecting..." : "Continue with \(provider.name ?? provider.id)",
                            style: .ghost,
                            isFullWidth: true,
                            isDisabled: authManager.isSubmitting
                        ) {
                            Task { await authManager.startProviderLogin(provider: provider) }
                        }
                    }
                }
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: VSpacing.sm) {
                Button {
                    authManager.errorMessage = nil
                    authManager.currentFlow = .forgotPassword
                } label: {
                    Text("Forgot password?")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)

                HStack(spacing: VSpacing.sm) {
                    if let onBack {
                        Button(action: onBack) {
                            Text("Back")
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                        }
                        .buttonStyle(.plain)

                        Text("|")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }

                    Button {
                        authManager.errorMessage = nil
                        authManager.currentFlow = .signup
                    } label: {
                        Text("Create an account?")
                            .font(VFont.caption)
                            .foregroundColor(VColor.accent)
                    }
                    .buttonStyle(.plain)
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .padding(VSpacing.xxl)
        .frame(width: 380)
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

    private func submit() {
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, !password.isEmpty else { return }
        Task { await authManager.login(email: trimmedEmail, password: password) }
    }
}

#if DEBUG
struct LoginView_Preview: PreviewProvider {
    static var previews: some View {
        LoginViewPreviewWrapper()
            .frame(width: 500, height: 600)
            .previewDisplayName("LoginView")
    }
}

private struct LoginViewPreviewWrapper: View {
    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            LoginView(authManager: AuthManager())
        }
    }
}
#endif
