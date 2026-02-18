#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

enum ConnectionMode: String, CaseIterable {
    case standalone = "Standalone"
    case connected = "Connected to Mac"
}

struct SettingsView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @AppStorage(UserDefaultsKeys.connectionMode) private var connectionMode: String = ConnectionMode.standalone.rawValue
    @AppStorage(UserDefaultsKeys.daemonTLSEnabled) private var tlsEnabled: Bool = false
    @AppStorage(UserDefaultsKeys.appearanceMode) private var appearanceMode: String = "system"
    @State private var apiKey: String = ""
    @State private var daemonHostname: String = ""
    @State private var daemonPort: String = ""
    @State private var sessionToken: String = ""
    @State private var showingAPIKeyAlert = false
    @State private var apiKeyAlertMessage = ""
    @State private var apiKeyAlertTitle = ""
    @State private var showingDaemonAlert = false
    @State private var daemonAlertMessage = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection Mode") {
                    Picker("Mode", selection: $connectionMode) {
                        ForEach(ConnectionMode.allCases, id: \.rawValue) { mode in
                            Text(mode.rawValue).tag(mode.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: connectionMode) { _, newMode in
                        switchClient(to: newMode)
                    }
                }

                if connectionMode == ConnectionMode.standalone.rawValue {
                    Section("Anthropic API Key") {
                        SecureField("Anthropic API Key", text: $apiKey)
                            .textContentType(.password)
                            .autocapitalization(.none)

                        Button("Save") {
                            let success = APIKeyManager.shared.setAPIKey(apiKey)
                            if success {
                                apiKeyAlertTitle = "Success"
                                apiKeyAlertMessage = "API Key saved securely"
                            } else {
                                apiKeyAlertTitle = "Error"
                                apiKeyAlertMessage = "Failed to save API Key to Keychain"
                            }
                            showingAPIKeyAlert = true
                        }
                        .disabled(apiKey.isEmpty)
                        Text("Your API key is stored locally and never sent to Vellum servers.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .alert(apiKeyAlertTitle, isPresented: $showingAPIKeyAlert) {
                        Button("OK") {}
                    } message: {
                        Text(apiKeyAlertMessage)
                    }
                } else {
                    Section("Mac Daemon") {
                        HStack {
                            Text("Hostname")
                            Spacer()
                            TextField("localhost", text: $daemonHostname)
                                .multilineTextAlignment(.trailing)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        HStack {
                            Text("Port")
                            Spacer()
                            TextField("8765", text: $daemonPort)
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.numberPad)
                        }
                        HStack {
                            Text("Session Token")
                            Spacer()
                            SecureField("From ~/.vellum/session-token", text: $sessionToken)
                                .multilineTextAlignment(.trailing)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        Text("Copy this from ~/.vellum/session-token on your Mac, or from Mac app → Settings.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Toggle("Use TLS", isOn: $tlsEnabled)

                        Button("Update") {
                            switch DaemonSettingsManager.validatePort(daemonPort) {
                            case .invalid(let message):
                                daemonAlertMessage = message
                                showingDaemonAlert = true
                                return
                            case .valid(let portInt):
                                DaemonSettingsManager.saveDaemonSettings(hostname: daemonHostname, port: portInt, sessionToken: sessionToken)
                            }
                            daemonAlertMessage = "Daemon connection settings updated"
                            showingDaemonAlert = true
                        }
                        .disabled(daemonHostname.isEmpty || daemonPort.isEmpty)
                    }
                    .alert("Daemon Settings", isPresented: $showingDaemonAlert) {
                        Button("OK") {}
                    } message: {
                        Text(daemonAlertMessage)
                    }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $appearanceMode) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Permissions") {
                    PermissionRowView(permission: .microphone)
                    PermissionRowView(permission: .speechRecognition)
                }

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.appVersion)
                }
            }
            .navigationTitle("Settings")
        }
        .onAppear {
            loadSettings()
        }
    }

    private func switchClient(to mode: String) {
        clientProvider.client.disconnect()
        let newClient: any DaemonClientProtocol
        if mode == ConnectionMode.connected.rawValue {
            newClient = DaemonClient(config: .fromUserDefaults())
        } else {
            newClient = DirectClaudeClient()
        }
        clientProvider.client = newClient
        Task { try? await clientProvider.client.connect() }
    }

    private func loadSettings() {
        apiKey = APIKeyManager.shared.getAPIKey() ?? ""
        let settings = DaemonSettingsManager.loadDaemonSettings()
        daemonHostname = settings.hostname
        daemonPort = settings.port
        sessionToken = settings.sessionToken
    }
}

struct PermissionRowView: View {
    let permission: PermissionManager.Permission
    @State private var status: PermissionStatus = .notDetermined
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        HStack {
            Text(permissionName)
            Spacer()
            statusIcon
            if status == .notDetermined {
                Button("Grant") {
                    Task {
                        let granted = await PermissionManager.shared.request(permission)
                        status = granted ? .granted : .denied
                    }
                }
            } else if status == .denied {
                Button("Open Settings") {
                    if let settingsUrl = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(settingsUrl)
                    }
                }
            }
        }
        .onAppear {
            status = PermissionManager.shared.status(for: permission)
        }
        .onChange(of: scenePhase) { _, newPhase in
            // Refresh status when returning from iOS Settings
            if newPhase == .active {
                status = PermissionManager.shared.status(for: permission)
            }
        }
    }

    private var permissionName: String {
        switch permission {
        case .microphone: return "Microphone"
        case .speechRecognition: return "Speech Recognition"
        }
    }

    private var statusIcon: some View {
        Image(systemName: statusIconName)
            .foregroundColor(statusColor)
    }

    private var statusIconName: String {
        switch status {
        case .granted: return "checkmark.circle.fill"
        case .denied: return "xmark.circle.fill"
        case .notDetermined: return "questionmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch status {
        case .granted: return VColor.success
        case .denied: return VColor.error
        case .notDetermined: return VColor.textMuted
        }
    }
}

extension Bundle {
    var appVersion: String {
        infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
}

#Preview {
    SettingsView()
        .environmentObject(ClientProvider(client: DirectClaudeClient()))
}
#endif
