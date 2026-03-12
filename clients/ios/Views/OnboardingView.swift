#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Onboarding step identifiers. The path branches at ChoosePath:
//   Welcome → ChoosePath → (LoginView | DaemonSetup) → Permissions → Ready
private enum OnboardingStep: Hashable {
    case welcome
    case choosePath
    case login
    case daemonSetup
    case permissions
    case ready
}

struct OnboardingView: View {
    @Binding var isCompleted: Bool
    @Bindable var authManager: AuthManager
    @State private var currentStep: OnboardingStep = .welcome

    var body: some View {
        ZStack {
            switch currentStep {
            case .welcome:
                WelcomeStep(onContinue: { currentStep = .choosePath })
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            case .choosePath:
                ChoosePathStep(
                    onLoginWithVellum: { currentStep = .login },
                    onConnectToMac: { currentStep = .daemonSetup }
                )
                .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            case .login:
                LoginView(
                    authManager: authManager,
                    onContinue: { currentStep = .permissions },
                    onCancel: { currentStep = .choosePath }
                )
                .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            case .daemonSetup:
                DaemonSetupStep(onContinue: { currentStep = .permissions })
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            case .permissions:
                PermissionsStep(onContinue: { currentStep = .ready })
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            case .ready:
                ReadyStep(isCompleted: $isCompleted)
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            }
        }
        .animation(.easeInOut, value: currentStep)
    }
}

// MARK: - WelcomeStep

struct WelcomeStep: View {
    var onContinue: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("✨")
                .font(VFont.onboardingEmoji)

            Text("Welcome to Vellum Assistant")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)
                .multilineTextAlignment(.center)

            Text("AI-powered assistant for your iPhone")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)

            Spacer()

            Button("Get Started", action: onContinue)
                .buttonStyle(.borderedProminent)
                .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
    }
}

// MARK: - ChoosePathStep

struct ChoosePathStep: View {
    var onLoginWithVellum: () -> Void
    var onConnectToMac: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("How would you like to connect?")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                Button(action: onLoginWithVellum) {
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Log in with Vellum")
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.contentDefault)
                            Text("Connect to your cloud assistant")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentSecondary)
                        }
                        Spacer()
                        VIconView(.cloud, size: 20)
                            .foregroundColor(VColor.primaryBase)
                    }
                    .padding(VSpacing.lg)
                    .background(VColor.surfaceBase)
                    .cornerRadius(VRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }

                Button(action: onConnectToMac) {
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Connect to Assistant")
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.contentDefault)
                            Text("Connect via your local network")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentSecondary)
                        }
                        Spacer()
                        VIconView(.monitor, size: 20)
                            .foregroundColor(VColor.primaryBase)
                    }
                    .padding(VSpacing.lg)
                    .background(VColor.surfaceBase)
                    .cornerRadius(VRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }
            }
            .padding(.horizontal, VSpacing.xl)

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}

// MARK: - DaemonSetupStep

struct DaemonSetupStep: View {
    var onContinue: (() -> Void)?
    @State private var showingQRPairing = false
    @State private var isPaired = false

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("Connect to Assistant")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Scan the QR code from your Assistant to pair.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            // QR Scanner button
            Button {
                showingQRPairing = true
            } label: {
                HStack(spacing: VSpacing.md) {
                    VIconView(.qrCode, size: 24)
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text("Scan QR Code")
                            .font(VFont.bodyBold)
                        Text("Open Vellum on your Assistant \u{2192} Settings \u{2192} Show QR Code")
                            .font(VFont.caption)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.lg)
                .background(VColor.surfaceBase)
                .cornerRadius(VRadius.md)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
            }
            .foregroundColor(VColor.contentDefault)
            .padding(.horizontal, VSpacing.xl)

            Button("Continue") {
                onContinue?()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!isPaired)

            Button("Skip for now") {
                onContinue?()
            }
            .foregroundColor(VColor.contentSecondary)

            Spacer()
        }
        .padding(VSpacing.xl)
        .sheet(isPresented: $showingQRPairing, onDismiss: {
            checkPairingState()
        }) {
            QRPairingSheet()
        }
        .onAppear {
            checkPairingState()
        }
    }

    private func checkPairingState() {
        let gatewayURL = UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL) ?? ""
        let bearerToken = APIKeyManager.shared.getAPIKey(provider: "runtime-bearer-token") ?? ""
        isPaired = !gatewayURL.isEmpty && !bearerToken.isEmpty
    }
}

// MARK: - PermissionsStep

struct PermissionsStep: View {
    var onContinue: (() -> Void)?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("Permissions")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Grant permissions for voice input")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                PermissionRowView(permission: .microphone)
                PermissionRowView(permission: .speechRecognition)
            }
            .padding(VSpacing.xl)
            .background(VColor.surfaceBase)
            .cornerRadius(VRadius.md)

            Spacer()

            Button("Continue", action: { onContinue?() })
                .buttonStyle(.borderedProminent)
                .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
    }
}

// MARK: - ReadyStep

struct ReadyStep: View {
    @Binding var isCompleted: Bool

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("You're All Set!")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Start chatting with your AI assistant")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)

            Button("Get Started") {
                isCompleted = true
            }
            .buttonStyle(.borderedProminent)

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}

#Preview {
    OnboardingView(isCompleted: .constant(false), authManager: AuthManager())
}
#endif
