import SwiftUI
import VellumAssistantShared

struct SettingsView: View {
    @State private var apiKey: String = ""
    @State private var daemonHostname: String = ""
    @State private var daemonPort: String = ""
    @State private var showingAPIKeySaved = false

    var body: some View {
        NavigationStack {
            Form {
                Section("API Key") {
                    SecureField("Anthropic API Key", text: $apiKey)
                        .textContentType(.password)
                        .autocapitalization(.none)

                    Button("Save") {
                        APIKeyManager.shared.setAPIKey(apiKey)
                        showingAPIKeySaved = true
                    }
                    .disabled(apiKey.isEmpty)
                }
                .alert("API Key Saved", isPresented: $showingAPIKeySaved) {
                    Button("OK") {}
                }

                Section("Daemon Connection") {
                    TextField("Hostname", text: $daemonHostname)
                        .textContentType(.URL)
                        .autocapitalization(.none)

                    TextField("Port", text: $daemonPort)
                        .keyboardType(.numberPad)

                    Button("Update") {
                        UserDefaults.standard.set(daemonHostname, forKey: "daemon_hostname")
                        if let port = Int(daemonPort) {
                            UserDefaults.standard.set(port, forKey: "daemon_port")
                        }
                    }
                    .disabled(daemonHostname.isEmpty || daemonPort.isEmpty)
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

    var body: some View {
        HStack {
            Text(permissionName)
            Spacer()
            statusIcon
            if status != .granted {
                Button("Grant") {
                    Task {
                        let granted = await PermissionManager.shared.request(permission)
                        status = granted ? .granted : .denied
                    }
                }
            }
        }
        .onAppear {
            status = PermissionManager.shared.status(for: permission)
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
