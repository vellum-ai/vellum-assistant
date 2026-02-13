import SwiftUI

@MainActor
struct ProviderSignupView: View {
    @Bindable var authManager: AuthManager
    @State private var email = ""
    @State private var username = ""
    @State private var isLoadingInfo = true
    @State private var localError: String?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.xs) {
                Text("Complete your account")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
                Text("Just a few more details to finish setting up your account.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }

            if isLoadingInfo {
                ProgressView()
                    .progressViewStyle(.circular)
            } else {
                VStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Email")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        VTextField(placeholder: "you@example.com", text: $email, leadingIcon: "envelope")
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Username")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        VTextField(placeholder: "Choose a username", text: $username, leadingIcon: "person") {
                            submit()
                        }
                    }

                    VButton(
                        label: authManager.isSubmitting ? "Completing signup..." : "Complete signup",
                        style: .primary,
                        isFullWidth: true,
                        isDisabled: authManager.isSubmitting || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        submit()
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
                Text("Back to sign in")
                    .font(VFont.caption)
                    .foregroundColor(VColor.accent)
            }
            .buttonStyle(.plain)
        }
        .padding(VSpacing.xxl)
        .frame(width: 380)
        .task {
            await loadSignupInfo()
        }
    }

    private func loadSignupInfo() async {
        do {
            let info = try await AuthService.shared.getProviderSignupInfo()
            if let prefillEmail = info.data?.email?.first(where: { $0.primary == true })?.email
                ?? info.data?.email?.first?.email
                ?? info.data?.user?.email {
                email = prefillEmail
            }
            if let prefillUsername = info.data?.user?.username {
                username = prefillUsername
            }
        } catch {
            localError = error.localizedDescription
        }
        isLoadingInfo = false
    }

    private func submit() {
        localError = nil
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, !trimmedUsername.isEmpty else { return }
        Task { await authManager.completeProviderSignup(email: trimmedEmail, username: trimmedUsername) }
    }
}

#if DEBUG
#Preview("ProviderSignupView") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ProviderSignupView(authManager: AuthManager())
    }
    .frame(width: 500, height: 500)
}
#endif
