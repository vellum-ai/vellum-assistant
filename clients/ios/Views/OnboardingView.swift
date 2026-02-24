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
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            Text("AI-powered assistant for your iPhone")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
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
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                Button(action: onLoginWithVellum) {
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Log in with Vellum")
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.textPrimary)
                            Text("Connect to your cloud assistant")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                        Spacer()
                        Image(systemName: "cloud")
                            .foregroundColor(VColor.accent)
                    }
                    .padding(VSpacing.lg)
                    .background(VColor.surface)
                    .cornerRadius(VRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                }

                Button(action: onConnectToMac) {
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Connect to Mac")
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.textPrimary)
                            Text("Use your Mac's local daemon")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                        Spacer()
                        Image(systemName: "desktopcomputer")
                            .foregroundColor(VColor.accent)
                    }
                    .padding(VSpacing.lg)
                    .background(VColor.surface)
                    .cornerRadius(VRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
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
    @State private var hostname = ""
    @State private var port = "8765"
    @State private var sessionToken = ""
    @State private var showingAlert = false
    @State private var alertMessage = ""
    @State private var showingQRPairing = false
    /// Tracks whether a token is configured (via QR or manual entry).
    /// Re-checked on appear and after QR sheet dismissal.
    @State private var hasConfiguredToken = false

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("Connect to Mac")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Scan the QR code from your Mac, or enter the connection details manually.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            // QR Scanner button
            Button {
                showingQRPairing = true
            } label: {
                HStack(spacing: VSpacing.md) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 24))
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text("Scan QR Code")
                            .font(VFont.bodyBold)
                        Text("Open Vellum on your Mac > Settings > Show QR Code")
                            .font(VFont.caption)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.lg)
                .background(VColor.surface)
                .cornerRadius(VRadius.md)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
            }
            .foregroundColor(VColor.textPrimary)
            .padding(.horizontal, VSpacing.xl)

            // Manual entry section
            VStack(spacing: VSpacing.lg) {
                Text("Or enter manually:")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)

                TextField("Hostname (e.g. 192.168.1.100)", text: $hostname)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()

                TextField("Port", text: $port)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.numberPad)

                SecureField("Session token", text: $sessionToken)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, VSpacing.xl)

            Button("Continue") {
                guard let portInt = Int(port), portInt > 0, portInt <= 65535 else {
                    alertMessage = "Port must be a valid number between 1 and 65535"
                    showingAlert = true
                    return
                }
                if !hostname.isEmpty {
                    UserDefaults.standard.set(hostname, forKey: UserDefaultsKeys.daemonHostname)
                }
                UserDefaults.standard.set(portInt, forKey: UserDefaultsKeys.daemonPort)
                // iOS always uses TLS for TCP connections
                UserDefaults.standard.set(true, forKey: UserDefaultsKeys.daemonTLSEnabled)
                if !sessionToken.isEmpty {
                    _ = APIKeyManager.shared.setAPIKey(sessionToken, provider: "daemon-token")
                }
                onContinue?()
            }
            .buttonStyle(.borderedProminent)
            // Enable if either QR pairing configured a token, or manual fields are filled
            .disabled(!hasConfiguredToken && (hostname.isEmpty || port.isEmpty || sessionToken.isEmpty))

            Button("Skip for now") {
                onContinue?()
            }
            .foregroundColor(VColor.textSecondary)

            Spacer()
        }
        .padding(VSpacing.xl)
        .alert("Daemon Setup", isPresented: $showingAlert) {
            Button("OK") {}
        } message: {
            Text(alertMessage)
        }
        .sheet(isPresented: $showingQRPairing, onDismiss: {
            reloadSettings()
        }) {
            QRPairingSheet()
        }
        .onAppear {
            reloadSettings()
        }
    }

    private func reloadSettings() {
        let storedHostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? ""
        if !storedHostname.isEmpty && storedHostname != "localhost" {
            hostname = storedHostname
        }
        let portValue = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
        port = portValue > 0 ? String(portValue) : "8765"
        sessionToken = APIKeyManager.shared.getAPIKey(provider: "daemon-token") ?? ""
        // Check if any token is configured (bare key or host-specific)
        hasConfiguredToken = !sessionToken.isEmpty || hasHostSpecificToken()
    }

    private func hasHostSpecificToken() -> Bool {
        let h = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? ""
        let p = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
        guard !h.isEmpty, p > 0 else { return false }
        return APIKeyManager.shared.getAPIKey(provider: "daemon-token:\(h):\(p)") != nil
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
                .foregroundColor(VColor.textPrimary)

            Text("Grant permissions for voice input")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                PermissionRowView(permission: .microphone)
                PermissionRowView(permission: .speechRecognition)
            }
            .padding(VSpacing.xl)
            .background(VColor.surface)
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
                .foregroundColor(VColor.textPrimary)

            Text("Start chatting with your AI assistant")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
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
