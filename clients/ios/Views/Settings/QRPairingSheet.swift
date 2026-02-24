#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// QR pairing sheet: scan QR code → parse → confirm → save config → connect.
struct QRPairingSheet: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Environment(\.dismiss) var dismiss

    @State private var phase: PairingPhase = .scanning
    @State private var scannedPayload: DaemonQRPayload?
    @State private var errorMessage: String?
    @State private var showGatewayChangedAlert = false
    @AppStorage(PairingConfiguration.devLocalPairingKey) private var devLocalPairingEnabled: Bool = false

    enum PairingPhase {
        case scanning
        case confirming
        /// Intermediate phase while showing the gateway-changed alert.
        /// Distinct from `.scanning` so that Cancel → `.scanning` is a real
        /// state transition, which forces SwiftUI to recreate the scanner view
        /// (the old QRScannerViewController has already stopped scanning).
        case confirmingUpdate
        case connecting
        case connected
        case alreadyConnected
        case error
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: VSpacing.xl) {
                switch phase {
                case .scanning:
                    scanningView
                case .confirming:
                    confirmingView
                case .confirmingUpdate:
                    // Empty placeholder behind the gateway-changed alert.
                    // Using a distinct phase ensures Cancel → .scanning is a
                    // real state transition that recreates the scanner.
                    Color.clear
                case .connecting:
                    connectingView
                case .connected:
                    connectedView
                case .alreadyConnected:
                    alreadyConnectedView
                case .error:
                    errorView
                }
            }
            .navigationTitle("Pair with Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert("Gateway Settings Changed", isPresented: $showGatewayChangedAlert) {
                Button("Update") {
                    connectToMac()
                }
                Button("Cancel", role: .cancel) {
                    // Keep existing values, return to scanning
                    scannedPayload = nil
                    phase = .scanning
                }
            } message: {
                Text("Your Mac's gateway settings have changed. Update connection?")
            }
        }
    }

    // MARK: - Scanning

    private var scanningView: some View {
        VStack(spacing: VSpacing.lg) {
            Text("Scan the QR code from your Mac to connect through the gateway.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            QRScannerView { code in
                handleScannedCode(code)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .cornerRadius(VRadius.md)
            .padding(.horizontal, VSpacing.lg)

            Text("Open Vellum on your Mac, go to Settings \u{2192} Connect, and tap Show QR Code. Ingress must be enabled on the Mac for pairing.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Confirming

    private var confirmingView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Image(systemName: "checkmark.circle")
                .font(.system(size: 48))
                .foregroundColor(VColor.accent)

            Text("QR Code Scanned")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            if let payload = scannedPayload {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    infoRow(label: "Gateway", value: payload.gatewayURL)
                }
                .padding(VSpacing.lg)
                .background(VColor.surface)
                .cornerRadius(VRadius.md)
                .padding(.horizontal, VSpacing.xl)

                if payload.mode == "local" {
                    HStack(spacing: 6) {
                        Image(systemName: "laptopcomputer.and.iphone")
                            .foregroundColor(VColor.warning)
                            .font(.system(size: 14))
                        Text("Local network connection (developer mode)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.warning)
                    }
                    .padding(VSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VColor.warning.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .padding(.horizontal, VSpacing.xl)
                }
            }

            Spacer()

            Button("Connect") {
                connectToMac()
            }
            .buttonStyle(.borderedProminent)
            .padding(.bottom, VSpacing.xxl)
        }
    }

    // MARK: - Connecting

    private var connectingView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            ProgressView()
                .controlSize(.large)
            Text("Connecting to Mac...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
            Spacer()
        }
    }

    // MARK: - Connected

    private var connectedView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundColor(VColor.success)

            Text("Connected!")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Your iPhone is now connected to your Mac.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            Spacer()

            Button("Done") {
                dismiss()
            }
            .buttonStyle(.borderedProminent)
            .padding(.bottom, VSpacing.xxl)
        }
    }

    // MARK: - Already Connected

    private var alreadyConnectedView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundColor(VColor.success)

            Text("Already Connected")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Already connected to this Mac.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            Spacer()

            Button("Done") {
                dismiss()
            }
            .buttonStyle(.borderedProminent)
            .padding(.bottom, VSpacing.xxl)
        }
    }

    // MARK: - Error

    private var errorView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundColor(VColor.error)

            Text("Connection Failed")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            if let message = errorMessage {
                Text(message)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
            }

            Spacer()

            VStack(spacing: VSpacing.md) {
                Button("Try Again") {
                    phase = .scanning
                    scannedPayload = nil
                    errorMessage = nil
                }
                .buttonStyle(.borderedProminent)

                Button("Cancel") {
                    dismiss()
                }
                .foregroundColor(VColor.textSecondary)
            }
            .padding(.bottom, VSpacing.xxl)
        }
    }

    // MARK: - Logic

    private func handleScannedCode(_ code: String) {
        guard let data = code.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            errorMessage = "Invalid QR code. Please scan the QR code from the Vellum Mac app."
            phase = .error
            return
        }

        guard json["type"] as? String == "vellum-daemon" else {
            errorMessage = "This QR code is not from Vellum. Open Vellum on your Mac and scan the QR code from Settings \u{2192} Connect."
            phase = .error
            return
        }

        let version = json["v"] as? Int ?? 0

        // Reject v1 and older payloads — require v2 with gateway URL
        guard version >= 2, json["g"] != nil else {
            errorMessage = "This QR code is from an older version of Vellum. Please update Vellum on your Mac to pair."
            phase = .error
            return
        }

        guard let gatewayURL = json["g"] as? String,
              let bearerToken = json["bt"] as? String,
              let hostId = json["id"] as? String else {
            errorMessage = "QR code is missing required fields. Please regenerate the QR code on your Mac."
            phase = .error
            return
        }

        // Validate HTTP scheme — require HTTPS for non-local, or devLocalPairingEnabled for local HTTP
        if let url = URL(string: gatewayURL), url.scheme?.lowercased() == "http" {
            guard let host = url.host, !host.isEmpty else {
                errorMessage = "Invalid HTTP URL — no host found."
                phase = .error
                return
            }
            let isLocal = DaemonConnectionSection.isLocalHost(host)
            if !isLocal {
                errorMessage = "HTTPS is required for non-local connections."
                phase = .error
                return
            }
            if !devLocalPairingEnabled {
                errorMessage = "Enable Developer Local Pairing in connection settings to use local HTTP gateways."
                phase = .error
                return
            }
        }

        let mode = json["m"] as? String

        let payload = DaemonQRPayload(
            gatewayURL: gatewayURL,
            bearerToken: bearerToken,
            hostId: hostId,
            mode: mode
        )
        scannedPayload = payload

        // Compare with stored values to detect first-time vs re-scan vs same config
        let storedGatewayURL = UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL) ?? ""
        let storedBearerToken = APIKeyManager.shared.getAPIKey(provider: "runtime-bearer-token") ?? ""

        let hasStoredConfig = !storedGatewayURL.isEmpty && !storedBearerToken.isEmpty
        let valuesMatch = storedGatewayURL == payload.gatewayURL && storedBearerToken == payload.bearerToken

        if !hasStoredConfig {
            // First-time scan — save directly, proceed to confirm then connect
            phase = .confirming
        } else if valuesMatch {
            // Same config — only show "already connected" if actually live.
            // If disconnected, reconnect so the user can recover by re-scanning.
            if clientProvider.isConnected {
                phase = .alreadyConnected
            } else {
                connectToMac()
            }
        } else {
            // Re-scan with different values — move to an intermediate phase
            // before showing the alert so Cancel → .scanning is a real state
            // change that recreates the (now-stopped) scanner.
            phase = .confirmingUpdate
            showGatewayChangedAlert = true
        }
    }

    private func connectToMac() {
        guard let payload = scannedPayload else { return }
        phase = .connecting

        // Check if this hostId matches a previously-stored host with a different gateway URL.
        // If so, clean up old config (same Mac, new gateway).
        detectAndMigrateHost(payload: payload)

        // Store gateway URL
        UserDefaults.standard.set(payload.gatewayURL, forKey: UserDefaultsKeys.gatewayBaseURL)

        // Store bearer token in Keychain
        _ = APIKeyManager.shared.setAPIKey(payload.bearerToken, provider: "runtime-bearer-token")

        // Generate and store a conversation key if one doesn't already exist
        if UserDefaults.standard.string(forKey: UserDefaultsKeys.conversationKey)?.isEmpty != false {
            UserDefaults.standard.set(UUID().uuidString, forKey: UserDefaultsKeys.conversationKey)
        }

        // Store host ID for migration detection
        if !payload.hostId.isEmpty {
            UserDefaults.standard.set(payload.hostId, forKey: "gateway_host_id")
        }

        // Clear old TCP-related UserDefaults from v1 pairing
        UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.daemonHostname)
        UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.daemonPort)
        UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.daemonTLSEnabled)

        // Rebuild the client so the new gateway config takes effect
        clientProvider.rebuildClient()

        // Connect
        Task {
            do {
                try await clientProvider.client.connect()
                await MainActor.run {
                    phase = .connected
                }
            } catch {
                await MainActor.run {
                    errorMessage = "Connection failed: \(error.localizedDescription)"
                    phase = .error
                }
            }
        }
    }

    /// If the scanned hostId matches a stored hostId for a different gateway URL,
    /// this is the same Mac with a new gateway. Clean up old config.
    private func detectAndMigrateHost(payload: DaemonQRPayload) {
        guard !payload.hostId.isEmpty else { return }

        let storedHostId = UserDefaults.standard.string(forKey: "gateway_host_id") ?? ""
        let storedGatewayURL = UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL) ?? ""

        // Same Mac (matching hostId) but different gateway URL — clean up old bearer token
        if storedHostId == payload.hostId && !storedGatewayURL.isEmpty && storedGatewayURL != payload.gatewayURL {
            _ = APIKeyManager.shared.deleteAPIKey(provider: "runtime-bearer-token")
        }

        // Also clean up any legacy TCP pairing config if a host ID was stored per-host:port
        let oldHostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? ""
        let oldPort = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
        if oldPort > 0 {
            let oldIdKey = UserDefaultsKeys.daemonHostId(host: oldHostname, port: UInt16(oldPort))
            let oldTcpHostId = UserDefaults.standard.string(forKey: oldIdKey)
            if oldTcpHostId == payload.hostId {
                let oldTokenProvider = "daemon-token:\(oldHostname):\(oldPort)"
                _ = APIKeyManager.shared.deleteAPIKey(provider: oldTokenProvider)
                _ = APIKeyManager.shared.deleteAPIKey(provider: "daemon-token")
                let oldFpKey = UserDefaultsKeys.daemonCertFingerprint(host: oldHostname, port: UInt16(oldPort))
                UserDefaults.standard.removeObject(forKey: oldFpKey)
                UserDefaults.standard.removeObject(forKey: oldIdKey)
            }
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 60, alignment: .leading)
            Text(value)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
            Spacer()
        }
    }
}

/// Parsed QR code payload from the macOS pairing QR code (v2 gateway format).
struct DaemonQRPayload {
    let gatewayURL: String
    let bearerToken: String
    let hostId: String
    let mode: String?  // "gateway", "local", or nil (legacy)
}
#endif
