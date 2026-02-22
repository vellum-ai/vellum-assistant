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
    @State private var daemonHostname: String = ""
    @State private var daemonPort: String = ""
    @State private var sessionToken: String = ""
    @State private var showingAlert = false
    @State private var alertMessage = ""
    @State private var showingQRPairing = false

    var body: some View {
        Section("Mac Daemon") {
            Button {
                showingQRPairing = true
            } label: {
                HStack {
                    Image(systemName: "qrcode.viewfinder")
                    Text("Scan QR Code")
                }
            }

            HStack {
                Text("Hostname")
                Spacer()
                TextField("e.g. 192.168.1.100", text: $daemonHostname)
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
            Text("Or scan the QR code from Mac app > Settings > Show QR Code.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Button("Update") {
                guard let port = Int(daemonPort), port > 0, port <= 65535 else {
                    alertMessage = "Port must be a valid number between 1 and 65535"
                    showingAlert = true
                    return
                }
                UserDefaults.standard.set(daemonHostname, forKey: UserDefaultsKeys.daemonHostname)
                UserDefaults.standard.set(port, forKey: UserDefaultsKeys.daemonPort)
                // iOS always uses TLS for TCP connections
                UserDefaults.standard.set(true, forKey: UserDefaultsKeys.daemonTLSEnabled)
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
        .sheet(isPresented: $showingQRPairing, onDismiss: {
            // Re-read settings after QR pairing in case they changed
            reloadSettings()
        }) {
            QRPairingSheet()
        }
        .onAppear {
            reloadSettings()
        }
    }

    private func reloadSettings() {
        daemonHostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? ""
        let portValue = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
        daemonPort = portValue > 0 ? String(portValue) : "8765"
        sessionToken = APIKeyManager.shared.getAPIKey(provider: "daemon-token") ?? ""
    }
}
#endif
