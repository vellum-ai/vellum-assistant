#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - Standalone API Key Section

struct APIKeySection: View {
    @State private var apiKey: String = ""
    @State private var showingAlert = false
    @State private var alertTitle = ""
    @State private var alertMessage = ""

    var body: some View {
        Section("Anthropic API Key") {
            SecureField("Anthropic API Key", text: $apiKey)
                .textContentType(.password)
                .autocapitalization(.none)

            Button("Save") {
                let success = APIKeyManager.shared.setAPIKey(apiKey)
                if success {
                    alertTitle = "Success"
                    alertMessage = "API Key saved securely"
                } else {
                    alertTitle = "Error"
                    alertMessage = "Failed to save API Key to Keychain"
                }
                showingAlert = true
            }
            .disabled(apiKey.isEmpty)
            Text("Your API key is stored locally and never sent to Vellum servers.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .alert(alertTitle, isPresented: $showingAlert) {
            Button("OK") {}
        } message: {
            Text(alertMessage)
        }
        .onAppear {
            apiKey = APIKeyManager.shared.getAPIKey() ?? ""
        }
    }
}

// MARK: - Connected Daemon Section

struct DaemonConnectionSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @AppStorage(UserDefaultsKeys.daemonTLSEnabled) private var tlsEnabled: Bool = false
    @State private var daemonHostname: String = ""
    @State private var daemonPort: String = ""
    @State private var sessionToken: String = ""
    @State private var showingAlert = false
    @State private var alertMessage = ""

    var body: some View {
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
                guard let port = Int(daemonPort), port > 0, port <= 65535 else {
                    alertMessage = "Port must be a valid number between 1 and 65535"
                    showingAlert = true
                    return
                }
                UserDefaults.standard.set(daemonHostname, forKey: UserDefaultsKeys.daemonHostname)
                UserDefaults.standard.set(port, forKey: UserDefaultsKeys.daemonPort)
                if sessionToken.isEmpty {
                    _ = APIKeyManager.shared.deleteAPIKey(provider: "daemon-token")
                    UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.legacyDaemonToken)
                } else {
                    _ = APIKeyManager.shared.setAPIKey(sessionToken, provider: "daemon-token")
                }
                // Rebuild the client so the new transport config takes effect,
                // then reconnect. DaemonClient transport is fixed at init, so
                // just calling connect() wouldn't pick up hostname/port changes.
                clientProvider.rebuildClient()
                Task {
                    try? await clientProvider.client.connect()
                }
                alertMessage = "Daemon connection settings updated"
                showingAlert = true
            }
            .disabled(daemonHostname.isEmpty || daemonPort.isEmpty)
        }
        .alert("Daemon Settings", isPresented: $showingAlert) {
            Button("OK") {}
        } message: {
            Text(alertMessage)
        }
        .onAppear {
            daemonHostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? "localhost"
            let portValue = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
            daemonPort = portValue > 0 ? String(portValue) : "8765"
            sessionToken = APIKeyManager.shared.getAPIKey(provider: "daemon-token") ?? ""
        }
    }
}
#endif
