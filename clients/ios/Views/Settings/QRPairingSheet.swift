#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// QR pairing sheet: scan v4 QR code → send pairing request → poll for approval → save config → connect.
///
/// v4 flow:
/// 1. Parse QR → extract pairingRequestId, pairingSecret, localLanUrl (nullable), gateway URL (g)
/// 2. If localLanUrl is non-nil, try LAN first: POST <localLanUrl>/pairing/request
/// 3. If LAN fails or localLanUrl is nil, use cloud gateway: POST <g>/pairing/request
/// 4. If approved immediately (auto-approve from allowlist) → save, connect
/// 5. If pending → show "Waiting for approval on Mac" → poll GET pairing/status every 2s
/// 6. On approved → save, connect. On denied → error. On expired → error.
struct QRPairingSheet: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Environment(\.dismiss) var dismiss

    @State private var phase: PairingPhase = .scanning
    @State private var scannedPayload: DaemonQRPayloadV4?
    @State private var errorMessage: String?
    @State private var pollTimer: Timer?
    @State private var pairingTask: Task<Void, Never>?

    enum PairingPhase {
        case scanning
        case requestingApproval
        case waitingForApproval
        case connecting
        case connected
        case error
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: VSpacing.xl) {
                switch phase {
                case .scanning:
                    scanningView
                case .requestingApproval:
                    requestingApprovalView
                case .waitingForApproval:
                    waitingView
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
                    Button("Cancel") {
                        pairingTask?.cancel()
                        pairingTask = nil
                        stopPolling()
                        dismiss()
                    }
                }
            }
        }
        .onDisappear {
            pairingTask?.cancel()
            pairingTask = nil
            stopPolling()
        }
    }

    // MARK: - Scanning

    private var scanningView: some View {
        VStack(spacing: VSpacing.lg) {
            Text("Scan the QR code from your Mac to pair.")
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

            Text("Open Vellum on your Mac, go to Settings \u{2192} Connect, and tap Show QR Code.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Requesting Approval

    private var requestingApprovalView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            ProgressView()
                .controlSize(.large)
            Text("Sending pairing request...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
            Spacer()
        }
    }

    // MARK: - Waiting for Approval

    private var waitingView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 48))
                .foregroundColor(VColor.accent)

            Text("Waiting for Approval")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Approve this pairing request on your Mac to continue.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            ProgressView()
                .controlSize(.small)

            Spacer()
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

            Text("Pairing Failed")
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
            errorMessage = "This doesn't look like a Vellum QR code. Open Vellum on your Mac \u{2192} Settings \u{2192} Connect \u{2192} Show QR Code."
            phase = .error
            return
        }

        guard json["type"] as? String == "vellum-daemon" else {
            errorMessage = "This QR code isn't from Vellum."
            phase = .error
            return
        }

        let version = json["v"] as? Int ?? 0

        // Reject v2/v3 QR codes — require v4
        guard version >= 4 else {
            errorMessage = "This QR code is outdated. Update Vellum on your Mac and try again."
            phase = .error
            return
        }

        guard let gatewayURL = json["g"] as? String,
              let hostId = json["id"] as? String,
              let pairingRequestId = json["pairingRequestId"] as? String,
              let pairingSecret = json["pairingSecret"] as? String else {
            errorMessage = "QR code is missing required fields. Show a new QR code on your Mac."
            phase = .error
            return
        }

        let localLanUrl = json["localLanUrl"] as? String

        let payload = DaemonQRPayloadV4(
            gatewayURL: gatewayURL,
            hostId: hostId,
            pairingRequestId: pairingRequestId,
            pairingSecret: pairingSecret,
            localLanUrl: localLanUrl
        )
        scannedPayload = payload
        sendPairingRequest(payload: payload)
    }

    // MARK: - Pairing Handshake

    private func sendPairingRequest(payload: DaemonQRPayloadV4) {
        phase = .requestingApproval

        let deviceId = getOrCreateDeviceId()
        let deviceName = UIDevice.current.name

        let body: [String: Any] = [
            "pairingRequestId": payload.pairingRequestId,
            "pairingSecret": payload.pairingSecret,
            "deviceId": deviceId,
            "deviceName": deviceName,
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            errorMessage = "Failed to create pairing request."
            phase = .error
            return
        }

        pairingTask = Task {
            // Try LAN first if available
            if let lanUrl = payload.localLanUrl,
               isAllowedLocalHttp(urlString: lanUrl, payload: payload) {
                let result = await attemptPairingRequest(
                    baseURL: lanUrl,
                    jsonData: jsonData,
                    timeoutSeconds: 3
                )
                if let result = result {
                    handlePairingResponse(result, payload: payload, effectiveBaseURL: lanUrl)
                    return
                }
                // LAN failed — but if we were cancelled while waiting, stop here
                // instead of falling through to the gateway path.
                guard !Task.isCancelled else { return }
                // Fall through to cloud gateway
            }

            // Cloud gateway
            let result = await attemptPairingRequest(
                baseURL: payload.gatewayURL,
                jsonData: jsonData,
                timeoutSeconds: 15
            )
            if let result = result {
                handlePairingResponse(result, payload: payload, effectiveBaseURL: payload.gatewayURL)
            } else if !Task.isCancelled {
                await MainActor.run {
                    errorMessage = "Could not reach your Mac. Make sure the Vellum daemon is running."
                    phase = .error
                }
            }
        }
    }

    private func attemptPairingRequest(baseURL: String, jsonData: Data, timeoutSeconds: TimeInterval) async -> [String: Any]? {
        guard let url = URL(string: "\(baseURL)/pairing/request") else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = jsonData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = timeoutSeconds

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return nil
            }
            return json
        } catch {
            return nil
        }
    }

    private func handlePairingResponse(_ response: [String: Any], payload: DaemonQRPayloadV4, effectiveBaseURL: String) {
        guard let status = response["status"] as? String else {
            errorMessage = "Unexpected response from Mac."
            phase = .error
            return
        }

        switch status {
        case "approved":
            guard let bearerToken = response["bearerToken"] as? String,
                  let gatewayUrl = response["gatewayUrl"] as? String else {
                errorMessage = "Approval response missing required fields."
                phase = .error
                return
            }
            let localLanUrl = response["localLanUrl"] as? String
            savePairingConfig(
                bearerToken: bearerToken,
                gatewayUrl: gatewayUrl,
                hostId: payload.hostId,
                localLanUrl: localLanUrl
            )
            connectToMac()

        case "pending":
            phase = .waitingForApproval
            startPolling(payload: payload, effectiveBaseURL: effectiveBaseURL)

        case "denied":
            errorMessage = "Pairing was denied on your Mac."
            phase = .error

        case "expired":
            errorMessage = "Pairing request expired. Show a new QR code on your Mac."
            phase = .error

        default:
            errorMessage = "Unexpected pairing status: \(status)"
            phase = .error
        }
    }

    // MARK: - Polling

    private func startPolling(payload: DaemonQRPayloadV4, effectiveBaseURL: String) {
        stopPolling()

        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { _ in
            Task {
                await pollPairingStatus(baseURL: effectiveBaseURL, payload: payload)
            }
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func pollPairingStatus(baseURL: String, payload: DaemonQRPayloadV4) async {
        guard let url = URL(string: "\(baseURL)/pairing/status?id=\(payload.pairingRequestId)&secret=\(payload.pairingSecret)") else {
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let status = json["status"] as? String else {
                return
            }

            await MainActor.run {
                switch status {
                case "approved":
                    stopPolling()
                    guard let bearerToken = json["bearerToken"] as? String,
                          let gatewayUrl = json["gatewayUrl"] as? String else {
                        errorMessage = "Approval response missing fields."
                        phase = .error
                        return
                    }
                    let localLanUrl = json["localLanUrl"] as? String
                    savePairingConfig(
                        bearerToken: bearerToken,
                        gatewayUrl: gatewayUrl,
                        hostId: payload.hostId,
                        localLanUrl: localLanUrl
                    )
                    connectToMac()

                case "denied":
                    stopPolling()
                    errorMessage = "Pairing was denied on your Mac."
                    phase = .error

                case "expired":
                    stopPolling()
                    errorMessage = "Pairing request expired. Show a new QR code on your Mac."
                    phase = .error

                default:
                    break // Still pending, keep polling
                }
            }
        } catch {
            // Network error during poll — ignore and retry
        }
    }

    // MARK: - Config Persistence

    private func savePairingConfig(bearerToken: String, gatewayUrl: String, hostId: String, localLanUrl: String?) {
        UserDefaults.standard.set(gatewayUrl, forKey: UserDefaultsKeys.gatewayBaseURL)
        _ = APIKeyManager.shared.setAPIKey(bearerToken, provider: "runtime-bearer-token")
        if !hostId.isEmpty {
            UserDefaults.standard.set(hostId, forKey: "gateway_host_id")
        }

        // Generate conversation key if missing
        if UserDefaults.standard.string(forKey: UserDefaultsKeys.conversationKey)?.isEmpty != false {
            UserDefaults.standard.set(UUID().uuidString, forKey: UserDefaultsKeys.conversationKey)
        }
    }

    private func connectToMac() {
        phase = .connecting
        clientProvider.rebuildClient()

        Task {
            do {
                try await clientProvider.client.connect()
                await MainActor.run {
                    phase = .connected
                }
            } catch {
                await MainActor.run {
                    errorMessage = "Couldn't connect: \(error.localizedDescription)"
                    phase = .error
                }
            }
        }
    }

    // MARK: - Device ID

    /// Get or create a stable device ID stored in the Keychain.
    private func getOrCreateDeviceId() -> String {
        if let existing = APIKeyManager.shared.getAPIKey(provider: "pairing-device-id"), !existing.isEmpty {
            return existing
        }
        let newId = UUID().uuidString
        _ = APIKeyManager.shared.setAPIKey(newId, provider: "pairing-device-id")
        return newId
    }

    // MARK: - HTTP Validation

    /// For v4 payloads, allow HTTP when the URL host is a local address AND
    /// the URL matches the localLanUrl from the payload.
    private func isAllowedLocalHttp(urlString: String, payload: DaemonQRPayloadV4) -> Bool {
        guard let url = URL(string: urlString),
              url.scheme?.lowercased() == "http",
              let host = url.host, !host.isEmpty else {
            return urlString.hasPrefix("https://")
        }
        guard urlString == payload.localLanUrl else { return false }
        return LocalAddressValidator.isLocalAddress(host)
    }
}

/// Parsed v4 QR code payload.
struct DaemonQRPayloadV4 {
    let gatewayURL: String
    let hostId: String
    let pairingRequestId: String
    let pairingSecret: String
    let localLanUrl: String?
}
#endif
