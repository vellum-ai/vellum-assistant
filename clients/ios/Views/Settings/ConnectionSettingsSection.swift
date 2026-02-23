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
    @State private var showingAlert = false
    @State private var alertMessage = ""
    @State private var showingQRPairing = false

    /// The currently configured gateway URL, shown as read-only status.
    private var gatewayURL: String? {
        UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL).flatMap { $0.isEmpty ? nil : $0 }
    }

    var body: some View {
        Form {
            Section {
                Button {
                    showingQRPairing = true
                } label: {
                    HStack {
                        Spacer()
                        VStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.system(size: 40))
                            Text("Scan QR Code")
                                .font(.headline)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 12)
                }
            } footer: {
                Text("Open Vellum on your Mac, then go to Settings > Show QR Code.")
            }

            if let url = gatewayURL {
                Section("Connection") {
                    HStack {
                        Text("Gateway")
                        Spacer()
                        Text(url)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }

            // Manual TCP setup removed — iOS uses HTTP+SSE exclusively via the gateway.
            // Gateway URL configuration will be added in M5.
        }
        .navigationTitle("Connect")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Daemon Settings", isPresented: $showingAlert) {
            Button("OK") {}
        } message: {
            Text(alertMessage)
        }
        .sheet(isPresented: $showingQRPairing) {
            QRPairingSheet()
        }
    }
}
#endif
