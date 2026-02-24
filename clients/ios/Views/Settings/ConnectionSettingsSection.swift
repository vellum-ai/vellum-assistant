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

    // Manual setup fields
    @State private var manualGatewayURL: String = ""
    @State private var manualAuthValue: String = ""
    @State private var isConnecting = false

    /// The currently configured gateway URL, shown as read-only status.
    private var gatewayURL: String? {
        UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Whether the current transport is HTTP (gateway-based).
    private var isHTTPTransport: Bool {
        gatewayURL != nil
    }

    var body: some View {
        Form {
            // Connection status section — always visible
            Section {
                if let url = gatewayURL {
                    if clientProvider.isConnected {
                        // Connected state
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(VColor.success)
                            Text("Connected")
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                        }
                    } else {
                        // Disconnected state — gateway configured but not connected
                        HStack {
                            Image(systemName: "exclamationmark.circle.fill")
                                .foregroundColor(VColor.error)
                            Text("Disconnected")
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                        }
                    }
                    HStack {
                        Text("Gateway")
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Text(url)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                } else {
                    // Not configured state
                    Text("Scan a QR code or enter your Mac's gateway URL to connect.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } header: {
                Text("Connection")
            }

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

            // Manual setup section
            Section {
                TextField("Gateway URL", text: $manualGatewayURL)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .textFieldStyle(.roundedBorder)

                SecureField("Bearer Token", text: $manualAuthValue)
                    .textContentType(.password)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .textFieldStyle(.roundedBorder)

                Button {
                    connectManually()
                } label: {
                    HStack {
                        Spacer()
                        if isConnecting {
                            ProgressView()
                                .controlSize(.small)
                                .padding(.trailing, 4)
                        }
                        Text("Connect")
                            .font(.headline)
                        Spacer()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(manualGatewayURL.isEmpty || manualAuthValue.isEmpty || isConnecting)
            } header: {
                Text("Manual Setup")
            } footer: {
                Text("Enter the gateway URL and bearer token shown in your Mac's Settings.")
            }

        }
        .navigationTitle("Connect")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Connection", isPresented: $showingAlert) {
            Button("OK") {}
        } message: {
            Text(alertMessage)
        }
        .sheet(isPresented: $showingQRPairing) {
            QRPairingSheet()
        }
    }

    // MARK: - Local Host Detection

    /// Checks whether a host string refers to a local or private-network address.
    /// Used to allow plain HTTP for LAN/loopback endpoints while requiring HTTPS
    /// for public hosts (ATS policy). Comparison is case-insensitive.
    static func isLocalHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased()

        // Loopback & mDNS
        if host == "localhost" || host == "::1" || host.hasSuffix(".local") {
            return true
        }

        // IPv6 link-local (fe80::…)
        if host.hasPrefix("fe80:") {
            return true
        }

        let octets = host.split(separator: ".").compactMap { UInt8($0) }
        if octets.count == 4 {
            // 127.0.0.0/8 — full loopback range
            if octets[0] == 127 { return true }
            // 10.0.0.0/8 — private
            if octets[0] == 10 { return true }
            // 172.16.0.0/12 — private (172.16.x.x through 172.31.x.x)
            if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
            // 192.168.0.0/16 — private
            if octets[0] == 192 && octets[1] == 168 { return true }
        }

        return false
    }

    // MARK: - Manual Connection

    private func connectManually() {
        // Validate the URL format
        let trimmedURL = manualGatewayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmedURL),
              url.scheme == "https" || url.scheme == "http",
              url.host != nil && !url.host!.isEmpty else {
            alertMessage = "Please enter a valid URL (e.g., https://my-mac.example.com)."
            showingAlert = true
            return
        }

        // Require HTTPS for non-local connections (ATS policy)
        if url.scheme == "http" {
            if !Self.isLocalHost(url.host ?? "") {
                alertMessage = "HTTPS is required for non-local connections."
                showingAlert = true
                return
            }
        }

        let trimmedAuth = manualAuthValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedAuth.isEmpty else {
            alertMessage = "Please enter a bearer token."
            showingAlert = true
            return
        }

        isConnecting = true

        // Store gateway URL
        UserDefaults.standard.set(trimmedURL, forKey: UserDefaultsKeys.gatewayBaseURL)

        // Store bearer token in Keychain
        _ = APIKeyManager.shared.setAPIKey(trimmedAuth, provider: "runtime-bearer-token")

        // Generate and store a conversation key automatically
        if UserDefaults.standard.string(forKey: UserDefaultsKeys.conversationKey)?.isEmpty != false {
            UserDefaults.standard.set(UUID().uuidString, forKey: UserDefaultsKeys.conversationKey)
        }

        // Rebuild the client so the new gateway config takes effect
        clientProvider.rebuildClient()

        // Connect
        Task {
            do {
                try await clientProvider.client.connect()
                await MainActor.run {
                    isConnecting = false
                    alertMessage = "Connected successfully!"
                    showingAlert = true
                    // Clear the manual input fields
                    manualGatewayURL = ""
                    manualAuthValue = ""
                }
            } catch {
                await MainActor.run {
                    isConnecting = false
                    alertMessage = "Connection failed: \(error.localizedDescription)"
                    showingAlert = true
                }
            }
        }
    }
}
#endif
