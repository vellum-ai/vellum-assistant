#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SettingsView: View {
    @State private var apiKey: String = ""
    @State private var daemonHostname: String = ""
    @State private var daemonPort: String = ""
    @State private var showingAPIKeyAlert = false
    @State private var apiKeyAlertMessage = ""
    @State private var apiKeyAlertTitle = ""
    @State private var showingDaemonAlert = false
    @State private var daemonAlertMessage = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("API Key") {
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
                }
                .alert(apiKeyAlertTitle, isPresented: $showingAPIKeyAlert) {
                    Button("OK") {}
                } message: {
                    Text(apiKeyAlertMessage)
                }

                Section("Daemon Connection") {
                    TextField("Hostname", text: $daemonHostname)
                        .textContentType(.URL)
                        .autocapitalization(.none)

                    TextField("Port", text: $daemonPort)
                        .keyboardType(.numberPad)

                    Button("Update") {
                        guard let port = Int(daemonPort), port > 0, port <= 65535 else {
                            daemonAlertMessage = "Port must be a valid number between 1 and 65535"
                            showingDaemonAlert = true
                            return
                        }
                        UserDefaults.standard.set(daemonHostname, forKey: "daemon_hostname")
                        UserDefaults.standard.set(port, forKey: "daemon_port")
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

    private func loadSettings() {
        apiKey = APIKeyManager.shared.getAPIKey() ?? ""
        daemonHostname = UserDefaults.standard.string(forKey: "daemon_hostname") ?? "localhost"
        let portValue = UserDefaults.standard.integer(forKey: "daemon_port")
        daemonPort = portValue > 0 ? String(portValue) : "8765"
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
}
#endif
