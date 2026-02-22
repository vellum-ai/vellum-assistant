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

    enum PairingPhase {
        case scanning
        case confirming
        case connecting
        case connected
        case error
    }

    var body: some View {
        NavigationView {
            VStack(spacing: VSpacing.xl) {
                switch phase {
                case .scanning:
                    scanningView
                case .confirming:
                    confirmingView
                case .connecting:
                    connectingView
                case .connected:
                    connectedView
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
        }
    }

    // MARK: - Scanning

    private var scanningView: some View {
        VStack(spacing: VSpacing.lg) {
            Text("Point your camera at the QR code shown in Vellum on your Mac.")
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

            Text("Open Vellum on your Mac > Settings > Show QR Code")
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
                    infoRow(label: "Mac IP", value: payload.host)
                    infoRow(label: "Port", value: "\(payload.port)")
                    infoRow(label: "TLS", value: "Enabled")
                }
                .padding(VSpacing.lg)
                .background(VColor.surface)
                .cornerRadius(VRadius.md)
                .padding(.horizontal, VSpacing.xl)
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
            errorMessage = "This QR code is not from Vellum. Open Vellum on your Mac and scan the QR code from Settings."
            phase = .error
            return
        }

        guard let version = json["v"] as? Int, version == 1 else {
            errorMessage = "QR code version not supported. Please update the Vellum app on your Mac."
            phase = .error
            return
        }

        guard let host = json["h"] as? String,
              let port = json["p"] as? Int,
              let token = json["t"] as? String,
              let fingerprint = json["f"] as? String else {
            errorMessage = "QR code is missing required fields. Please regenerate the QR code on your Mac."
            phase = .error
            return
        }

        let hostId = json["id"] as? String ?? ""

        scannedPayload = DaemonQRPayload(
            host: host,
            port: port,
            token: token,
            fingerprint: fingerprint,
            hostId: hostId
        )
        phase = .confirming
    }

    private func connectToMac() {
        guard let payload = scannedPayload else { return }
        phase = .connecting

        // Check if this hostId matches a previously-stored host with a different IP.
        // If so, update the stored hostname (same Mac, new IP).
        detectAndMigrateHost(payload: payload)

        // Save connection config
        let hostname = payload.host
        let port = payload.port

        UserDefaults.standard.set(hostname, forKey: UserDefaultsKeys.daemonHostname)
        UserDefaults.standard.set(port, forKey: UserDefaultsKeys.daemonPort)
        UserDefaults.standard.set(true, forKey: UserDefaultsKeys.daemonTLSEnabled)

        // Store token with host-specific key
        let hostSpecificProvider = "daemon-token:\(hostname):\(port)"
        _ = APIKeyManager.shared.setAPIKey(payload.token, provider: hostSpecificProvider)
        // Also store as bare key for backwards compatibility
        _ = APIKeyManager.shared.setAPIKey(payload.token, provider: "daemon-token")

        // Store fingerprint and hostId per host:port
        let fpKey = UserDefaultsKeys.daemonCertFingerprint(host: hostname, port: UInt16(port))
        UserDefaults.standard.set(payload.fingerprint, forKey: fpKey)

        if !payload.hostId.isEmpty {
            let idKey = UserDefaultsKeys.daemonHostId(host: hostname, port: UInt16(port))
            UserDefaults.standard.set(payload.hostId, forKey: idKey)
        }

        // Rebuild the client so the new TCP config takes effect
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
                    let nsError = error as NSError
                    if nsError.domain == "NWError" {
                        if nsError.localizedDescription.contains("TLS") || nsError.localizedDescription.contains("SSL") {
                            errorMessage = "TLS handshake failed. The certificate may have changed — try regenerating the QR code on your Mac."
                        } else if nsError.localizedDescription.contains("refused") {
                            errorMessage = "Connection refused. Make sure the Vellum daemon is running on your Mac and iOS pairing is enabled."
                        } else {
                            errorMessage = "Connection failed: \(error.localizedDescription)"
                        }
                    } else {
                        errorMessage = "Connection failed: \(error.localizedDescription)"
                    }
                    phase = .error
                }
            }
        }
    }

    /// If the scanned hostId matches a stored hostId for a different hostname,
    /// this is the same Mac with a new IP. Clean up old Keychain entries.
    private func detectAndMigrateHost(payload: DaemonQRPayload) {
        guard !payload.hostId.isEmpty else { return }

        let currentHostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? ""
        let currentPort = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
        guard currentPort > 0 else { return }

        let oldIdKey = UserDefaultsKeys.daemonHostId(host: currentHostname, port: UInt16(currentPort))
        let storedHostId = UserDefaults.standard.string(forKey: oldIdKey)

        // Same Mac (matching hostId) but different IP — clean up old keys
        if storedHostId == payload.hostId && currentHostname != payload.host {
            let oldTokenProvider = "daemon-token:\(currentHostname):\(currentPort)"
            _ = APIKeyManager.shared.deleteAPIKey(provider: oldTokenProvider)
            let oldFpKey = UserDefaultsKeys.daemonCertFingerprint(host: currentHostname, port: UInt16(currentPort))
            UserDefaults.standard.removeObject(forKey: oldFpKey)
            UserDefaults.standard.removeObject(forKey: oldIdKey)
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

/// Parsed QR code payload from the macOS pairing QR code.
struct DaemonQRPayload {
    let host: String
    let port: Int
    let token: String
    let fingerprint: String
    let hostId: String
}
#endif
