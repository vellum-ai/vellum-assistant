#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct OnboardingView: View {
    @Binding var isCompleted: Bool
    @Bindable var authManager: AuthManager
    @State private var currentStep = 0

    // Steps: Welcome(0) → DaemonSetup(1) → Permissions(2) → Ready(3)
    // Note: Cloud login path (ChoosePath/LoginView) is disabled until
    // platform.vellum.ai is deployed. Re-enable when the platform is live.

    var body: some View {
        TabView(selection: $currentStep) {
            WelcomeStep(onContinue: { currentStep = 1 })
                .tag(0)

            DaemonSetupStep(onContinue: { currentStep = 2 })
                .tag(1)

            PermissionsStep(onContinue: { currentStep = 3 })
                .tag(2)

            ReadyStep(isCompleted: $isCompleted)
                .tag(3)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
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
    @State private var hostname = "localhost"
    @State private var port = "8765"
    @State private var sessionToken = ""
    @State private var showingAlert = false
    @State private var alertMessage = ""

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("Connect to Mac")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Enter your Mac's address and the session token from the Vellum desktop app.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            VStack(spacing: VSpacing.lg) {
                TextField("Hostname (e.g. localhost)", text: $hostname)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()

                TextField("Port", text: $port)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.numberPad)

                SecureField("Session token (from ~/.vellum/session-token)", text: $sessionToken)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()

                Text("Find the token at ~/.vellum/session-token on your Mac, or in Mac app Settings.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, VSpacing.xl)

            Button("Continue") {
                guard let portInt = Int(port), portInt > 0, portInt <= 65535 else {
                    alertMessage = "Port must be a valid number between 1 and 65535"
                    showingAlert = true
                    return
                }
                UserDefaults.standard.set(hostname, forKey: UserDefaultsKeys.daemonHostname)
                UserDefaults.standard.set(portInt, forKey: UserDefaultsKeys.daemonPort)
                if sessionToken.isEmpty {
                    _ = APIKeyManager.shared.deleteAPIKey(provider: "daemon-token")
                    UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.legacyDaemonToken)
                } else {
                    _ = APIKeyManager.shared.setAPIKey(sessionToken, provider: "daemon-token")
                }
                onContinue?()
            }
            .buttonStyle(.borderedProminent)
            .disabled(hostname.isEmpty || port.isEmpty || sessionToken.isEmpty)

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
        .onAppear {
            hostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? "localhost"
            let portValue = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
            port = portValue > 0 ? String(portValue) : "8765"
            sessionToken = APIKeyManager.shared.getAPIKey(provider: "daemon-token") ?? ""
        }
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
