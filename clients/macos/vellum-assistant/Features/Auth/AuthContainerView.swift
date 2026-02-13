import SwiftUI

@MainActor
struct AuthContainerView: View {
    @Bindable var authManager: AuthManager

    var body: some View {
        ZStack {
            VColor.background
                .ignoresSafeArea()

            ScrollView {
                VStack {
                    Spacer(minLength: VSpacing.xxl)

                    Image(systemName: "sparkles")
                        .font(.system(size: 28))
                        .foregroundColor(VColor.accent)
                        .padding(.bottom, VSpacing.sm)

                    Group {
                        switch authManager.currentFlow {
                        case .login:
                            LoginView(authManager: authManager)
                        case .signup:
                            SignupView(authManager: authManager)
                        case .verifyEmail:
                            EmailVerificationView(authManager: authManager)
                        case .providerSignup:
                            ProviderSignupView(authManager: authManager)
                        case .forgotPassword:
                            ForgotPasswordView(authManager: authManager)
                        }
                    }
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 8)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .animation(VAnimation.standard, value: authManager.currentFlow)

                    Spacer(minLength: VSpacing.xxl)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

#if DEBUG
#Preview("AuthContainerView") {
    AuthContainerView(authManager: AuthManager())
        .frame(width: 500, height: 700)
}
#endif
