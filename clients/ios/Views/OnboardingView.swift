#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct OnboardingView: View {
    @Binding var isCompleted: Bool
    @State private var currentStep = 0
    @State private var connectionMode: String = ConnectionMode.standalone.rawValue

    // Total steps varies by mode:
    // standalone: Welcome(0) → Mode(1) → APIKey(2) → Permissions(3) → Ready(4)
    // connected:  Welcome(0) → Mode(1) → Daemon(2) → Permissions(3) → Ready(4)

    var body: some View {
        TabView(selection: $currentStep) {
            WelcomeStep(onContinue: { currentStep = 1 })
                .tag(0)

            ConnectionModeStep(
                selectedMode: $connectionMode,
                onContinue: { currentStep = 2 }
            )
            .tag(1)

            if connectionMode == ConnectionMode.standalone.rawValue {
                APIKeyStep(onContinue: { currentStep = 3 })
                    .tag(2)
            } else {
                DaemonSetupStep(onContinue: { currentStep = 3 })
                    .tag(2)
            }

            PermissionsStep(onContinue: { currentStep = 4 })
                .tag(3)

            ReadyStep(isCompleted: $isCompleted)
                .tag(4)
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
                .font(.system(size: 80))

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

// MARK: - ConnectionModeStep

struct ConnectionModeStep: View {
    @Binding var selectedMode: String
    var onContinue: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("🔗")
                .font(.system(size: 80))

            Text("How do you want to connect?")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.md) {
                ModeCard(
                    title: "Standalone",
                    subtitle: "Use your own Anthropic API key directly on device",
                    systemImage: "iphone",
                    isSelected: selectedMode == ConnectionMode.standalone.rawValue
                ) {
                    selectedMode = ConnectionMode.standalone.rawValue
                    UserDefaults.standard.set(ConnectionMode.standalone.rawValue, forKey: UserDefaultsKeys.connectionMode)
                }

                ModeCard(
                    title: "Connect to Mac",
                    subtitle: "Route requests through Vellum on your Mac",
                    systemImage: "desktopcomputer",
                    isSelected: selectedMode == ConnectionMode.connected.rawValue
                ) {
                    selectedMode = ConnectionMode.connected.rawValue
                    UserDefaults.standard.set(ConnectionMode.connected.rawValue, forKey: UserDefaultsKeys.connectionMode)
                }
            }
            .padding(.horizontal, VSpacing.lg)

            Spacer()

            Button("Continue", action: onContinue)
                .buttonStyle(.borderedProminent)
                .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
        .onAppear {
            let saved = UserDefaults.standard.string(forKey: UserDefaultsKeys.connectionMode) ?? ConnectionMode.standalone.rawValue
            selectedMode = saved
        }
    }
}

private struct ModeCard: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.md) {
                Image(systemName: systemImage)
                    .font(.system(size: 28))
                    .foregroundColor(isSelected ? VColor.accent : VColor.textSecondary)
                    .frame(width: 40)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(title)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.leading)
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.accent)
                }
            }
            .padding(VSpacing.lg)
            .background(VColor.surface)
            .cornerRadius(VRadius.md)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.accent : Color.clear, lineWidth: 2)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - APIKeyStep

struct APIKeyStep: View {
    @State private var apiKey: String = ""
    var onContinue: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("🔑")
                .font(.system(size: 80))

            Text("Anthropic API Key")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            Text("Enter your API key to use Claude directly on device")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.md) {
                SecureField("sk-ant-...", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()

                Text("Stored securely in the device Keychain. Never sent to Vellum servers.")
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, VSpacing.lg)

            Spacer()

            VStack(spacing: VSpacing.sm) {
                Button("Save & Continue") {
                    _ = APIKeyManager.shared.setAPIKey(apiKey)
                    onContinue()
                }
                .buttonStyle(.borderedProminent)
                .disabled(apiKey.isEmpty)

                Button("Skip for now", action: onContinue)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
            .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
    }
}

// MARK: - DaemonSetupStep (updated to accept onContinue)

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

            Text("🔌")
                .font(.system(size: 80))

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

                Text("Find the token at ~/.vellum/session-token on your Mac, or in Mac app → Settings → Daemon.")
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
                    // Also clear legacy UserDefaults key so migrateAuthToken() can't resurrect it
                    UserDefaults.standard.removeObject(forKey: "daemon_auth_token")
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

// MARK: - PermissionsStep (updated to accept onContinue)

struct PermissionsStep: View {
    var onContinue: (() -> Void)?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("🎤")
                .font(.system(size: 80))

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

            Text("🎉")
                .font(.system(size: 80))

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
    OnboardingView(isCompleted: .constant(false))
}
#endif
