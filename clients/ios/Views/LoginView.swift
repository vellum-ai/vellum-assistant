#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct LoginView: View {
    @Bindable var authManager: AuthManager
    /// When true, the primary button advances without invoking WorkOS login.
    /// Used by the developer "Replay Onboarding" tool so re-viewing the screen
    /// does not kick off a real auth flow for an already-authenticated user.
    var isReplay: Bool = false
    /// Called after a successful login so the onboarding flow can advance.
    var onContinue: (() -> Void)?

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()

            VStack(spacing: 0) {
                // Vertical rhythm matches Figma Light 169:
                // - Capped top gap so content doesn't drift to the middle.
                // - Flexible gap between icon and welcome text absorbs the
                //   screen-height variance (this is the largest gap in Figma).
                // - Compact welcome→button and button→footer gaps.
                Spacer().frame(maxHeight: 80)

                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [
                                    Color(hex: 0x4F8256).opacity(0.18),
                                    Color.clear,
                                ],
                                center: .center,
                                startRadius: 0,
                                endRadius: 80
                            )
                        )
                        .frame(width: 160, height: 160)

                    VellumAppIconView()
                }

                Spacer()

                VStack(spacing: VSpacing.lg) {
                    Text("Welcome to Vellum")
                        .font(VFont.displayLarge)
                        .foregroundStyle(VColor.contentDefault)
                        .multilineTextAlignment(.center)

                    Text("The safest way to create your personal assistant.")
                        .font(VFont.bodyLargeDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, VSpacing.lg)

                Spacer().frame(maxHeight: VSpacing.xxxl)

                if let error = authManager.errorMessage {
                    Text(error)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, VSpacing.xl)
                        .padding(.bottom, VSpacing.sm)
                }

                VStack(spacing: VSpacing.sm) {
                    Button {
                        if isReplay {
                            onContinue?()
                        } else {
                            Task {
                                await authManager.startWorkOSLogin()
                                if authManager.isAuthenticated {
                                    onContinue?()
                                }
                            }
                        }
                    } label: {
                        ZStack {
                            if authManager.isSubmitting && !isReplay {
                                ProgressView()
                                    .tint(VColor.contentInset)
                            } else {
                                Text("Log In")
                                    .font(VFont.bodyLargeEmphasised)
                                    .foregroundStyle(VColor.contentInset)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .background(VColor.primaryBase)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .disabled(authManager.isSubmitting && !isReplay)
                }
                .padding(.horizontal, VSpacing.lg)

                Text("2026 Vellum Inc.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDisabled)
                    .padding(.top, VSpacing.xl)
                    .padding(.bottom, VSpacing.md)
            }
        }
    }
}

// MARK: - Vellum App Icon

/// Reproduces the Vellum app icon: green gradient rounded square with the
/// white "V" shape from AppIcon.icon/Assets/white-V.svg (viewBox 0 0 92 92).
private struct VellumAppIconView: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(hex: 0x7A8B6F),
                            Color(hex: 0x4F8256),
                            Color(hex: 0x397E4A),
                            Color(hex: 0x23793D),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .shadow(color: .black.opacity(0.15), radius: 2, x: 0, y: 1)

            VellumVShape()
                .fill(.white)
                // V shape sits at ~51% of icon width / ~53% of icon height.
                .frame(width: 45, height: 47)
        }
        .frame(width: 88, height: 88)
    }
}

/// The "V" chevron path scaled from the SVG viewBox (0 0 92 92).
private struct VellumVShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let scaleX = rect.width / 92
        let scaleY = rect.height / 92
        path.move(to:    CGPoint(x: 23.5000 * scaleX, y:  0.000 * scaleY))
        path.addLine(to: CGPoint(x: 46.0000 * scaleX, y: 48.342 * scaleY))
        path.addLine(to: CGPoint(x: 68.4107 * scaleX, y:  0.000 * scaleY))
        path.addLine(to: CGPoint(x: 91.0000 * scaleX, y:  0.000 * scaleY))
        path.addLine(to: CGPoint(x: 45.8214 * scaleX, y: 92.000 * scaleY))
        path.addLine(to: CGPoint(x:  1.0000 * scaleX, y:  0.000 * scaleY))
        path.closeSubpath()
        return path
    }
}
#endif
