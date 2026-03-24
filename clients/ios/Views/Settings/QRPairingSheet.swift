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
    @State private var failureReason: String?
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
            .navigationTitle("Pair with Assistant")
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
            Text("Scan the QR code from your Assistant to pair.")
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            QRScannerView { code in
                handleScannedCode(code)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .cornerRadius(VRadius.md)
            .padding(.horizontal, VSpacing.lg)

            Text("Open Vellum on your Assistant, go to Settings \u{2192} Connect, and tap Show QR Code.")
                .font(VFont.labelDefault)
                .foregroundColor(VColor.contentTertiary)
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
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)
            Spacer()
        }
    }

    // MARK: - Waiting for Approval

    private var waitingView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            VIconView(.laptop, size: 48)
                .foregroundColor(VColor.primaryBase)

            Text("Waiting for Approval")
                .font(VFont.titleMedium)
                .foregroundColor(VColor.contentDefault)

            Text("Approve this pairing request on your Assistant to continue.")
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)
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
            Text("Connecting to Assistant...")
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)
            Spacer()
        }
    }

    // MARK: - Connected

    private var connectedView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            VIconView(.circleCheck, size: 64)
                .foregroundColor(VColor.systemPositiveStrong)

            Text("Connected!")
                .font(VFont.titleMedium)
                .foregroundColor(VColor.contentDefault)

            Text("Your iPhone is now connected to your Assistant.")
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)
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

            VIconView(.triangleAlert, size: 48)
                .foregroundColor(VColor.systemNegativeStrong)

            Text("Pairing Failed")
                .font(VFont.titleMedium)
                .foregroundColor(VColor.contentDefault)

            if let message = errorMessage {
                Text(message)
                    .font(VFont.bodyMediumLighter)
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
            }

            if let payload = scannedPayload {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Debug Info")
                        .font(VFont.labelDefault)
                        .foregroundColor(VColor.contentSecondary)
                    Group {
                        if let reason = failureReason {
                            Text("Reason: \(reason)")
                        }
                        Text("Gateway: \(payload.gatewayURL)")
                        Text("LAN: \(payload.localLanUrl ?? "none")")
                        Text("Host ID: \(String(payload.hostId.prefix(12)))…")
                        Text("Request ID: \(String(payload.pairingRequestId.prefix(8)))…")
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(VColor.contentSecondary)
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.vertical, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(.systemGray6))
                )
                .padding(.horizontal, VSpacing.xl)
            }

            Spacer()

            VStack(spacing: VSpacing.md) {
                Button("Try Again") {
                    phase = .scanning
                    scannedPayload = nil
                    errorMessage = nil
                    failureReason = nil
                }
                .buttonStyle(.borderedProminent)

                Button("Cancel") {
                    dismiss()
                }
                .foregroundColor(VColor.contentSecondary)
            }
            .padding(.bottom, VSpacing.xxl)
        }
    }

    // MARK: - Logic

    private func handleScannedCode(_ code: String) {
        guard let data = code.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            errorMessage = "This doesn't look like a Vellum QR code. Open Vellum on your Assistant \u{2192} Settings \u{2192} Connect \u{2192} Show QR Code."
            phase = .error
            return
        }

        guard json["type"] as? String == "vellum-assistant" || json["type"] as? String == "vellum-daemon" else {
            errorMessage = "This QR code isn't from Vellum."
            phase = .error
            return
        }

        let version = json["v"] as? Int ?? 0

        // Reject v2/v3 QR codes — require v4
        guard version >= 4 else {
            errorMessage = "This QR code is outdated. Update Vellum on your Assistant and try again."
            phase = .error
            return
        }

        guard let gatewayURL = json["g"] as? String,
              let hostId = json["id"] as? String,
              let pairingRequestId = json["pairingRequestId"] as? String,
              let pairingSecret = json["pairingSecret"] as? String else {
            errorMessage = "QR code is missing required fields. Show a new QR code on your Assistant."
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
            var lastFailureReason: String?

            // Try LAN first if available
            if let lanUrl = payload.localLanUrl,
               isAllowedLocalHttp(urlString: lanUrl, payload: payload) {
                let (json, reason) = await attemptPairingRequest(
                    baseURL: lanUrl,
                    jsonData: jsonData,
                    timeoutSeconds: 3
                )
                if let json = json {
                    handlePairingResponse(json, payload: payload, effectiveBaseURL: lanUrl)
                    return
                }
                lastFailureReason = reason.map { "LAN: \($0)" }
                // LAN failed — but if we were cancelled while waiting, stop here
                // instead of falling through to the gateway path.
                guard !Task.isCancelled else { return }
                // Fall through to cloud gateway
            }

            // Cloud gateway
            let (json, reason) = await attemptPairingRequest(
                baseURL: payload.gatewayURL,
                jsonData: jsonData,
                timeoutSeconds: 15
            )
            if let json = json {
                handlePairingResponse(json, payload: payload, effectiveBaseURL: payload.gatewayURL)
            } else if !Task.isCancelled {
                let gatewayReason = reason.map { "Gateway: \($0)" }
                let combinedReason = [lastFailureReason, gatewayReason].compactMap { $0 }.joined(separator: "\n")
                await MainActor.run {
                    errorMessage = "Could not reach your Assistant. Make sure your Assistant is online and try again."
                    failureReason = combinedReason.isEmpty ? nil : combinedReason
                    phase = .error
                }
            }
        }
    }

    private func attemptPairingRequest(baseURL: String, jsonData: Data, timeoutSeconds: TimeInterval) async -> (json: [String: Any]?, failureReason: String?) {
        guard let url = URL(string: "\(baseURL)/pairing/request") else {
            return (nil, "Invalid URL: \(baseURL)/pairing/request")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = jsonData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = timeoutSeconds

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return (nil, "Non-HTTP response from \(baseURL)")
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? ""
                return (nil, "HTTP \(httpResponse.statusCode) from \(baseURL): \(body)")
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return (nil, "Invalid JSON response from \(baseURL)")
            }
            return (json, nil)
        } catch {
            return (nil, "\(error.localizedDescription)")
        }
    }

    private func handlePairingResponse(_ response: [String: Any], payload: DaemonQRPayloadV4, effectiveBaseURL: String) {
        guard let status = response["status"] as? String else {
            errorMessage = "Unexpected response from Assistant."
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
            // Accept "accessToken" (new JWT field) or legacy "actorToken"
            let accessToken = (response["accessToken"] as? String) ?? (response["actorToken"] as? String)
            guard let accessToken, !accessToken.isEmpty else {
                errorMessage = "Pairing succeeded but device identity token is missing. Update your Assistant and pair again."
                failureReason = "Missing accessToken in approved pairing response"
                phase = .error
                return
            }
            let localLanUrl = response["localLanUrl"] as? String
            let refreshToken = response["refreshToken"] as? String
            // Accept "accessTokenExpiresAt" (new) or legacy "actorTokenExpiresAt"
            let accessTokenExpiresAt = (response["accessTokenExpiresAt"] as? Int) ?? (response["actorTokenExpiresAt"] as? Int)
            let refreshTokenExpiresAt = response["refreshTokenExpiresAt"] as? Int
            let refreshAfter = response["refreshAfter"] as? Int
            savePairingConfig(
                bearerToken: bearerToken,
                gatewayUrl: gatewayUrl,
                hostId: payload.hostId,
                localLanUrl: localLanUrl,
                actorToken: accessToken,
                refreshToken: refreshToken,
                actorTokenExpiresAt: accessTokenExpiresAt,
                refreshTokenExpiresAt: refreshTokenExpiresAt,
                refreshAfter: refreshAfter
            )
            connectToMac()

        case "pending":
            phase = .waitingForApproval
            startPolling(payload: payload, effectiveBaseURL: effectiveBaseURL)

        case "denied":
            errorMessage = "Pairing was denied on your Assistant."
            phase = .error

        case "expired":
            errorMessage = "Pairing request expired. Show a new QR code on your Assistant."
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
        var components = URLComponents(string: "\(baseURL)/pairing/status")
        components?.queryItems = [
            URLQueryItem(name: "id", value: payload.pairingRequestId),
            URLQueryItem(name: "secret", value: payload.pairingSecret),
            URLQueryItem(name: "deviceId", value: getOrCreateDeviceId()),
        ]
        guard let url = components?.url else {
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
                    // Accept "accessToken" (new JWT field) or legacy "actorToken"
                    let pollAccessToken = (json["accessToken"] as? String) ?? (json["actorToken"] as? String)
                    guard let pollAccessToken, !pollAccessToken.isEmpty else {
                        errorMessage = "Pairing succeeded but device identity token is missing. Update your Assistant and pair again."
                        failureReason = "Missing accessToken in approved pairing poll response"
                        phase = .error
                        return
                    }
                    let localLanUrl = json["localLanUrl"] as? String
                    let refreshToken = json["refreshToken"] as? String
                    // Accept "accessTokenExpiresAt" (new) or legacy "actorTokenExpiresAt"
                    let pollAccessTokenExpiresAt = (json["accessTokenExpiresAt"] as? Int) ?? (json["actorTokenExpiresAt"] as? Int)
                    let refreshTokenExpiresAt = json["refreshTokenExpiresAt"] as? Int
                    let refreshAfter = json["refreshAfter"] as? Int
                    savePairingConfig(
                        bearerToken: bearerToken,
                        gatewayUrl: gatewayUrl,
                        hostId: payload.hostId,
                        localLanUrl: localLanUrl,
                        actorToken: pollAccessToken,
                        refreshToken: refreshToken,
                        actorTokenExpiresAt: pollAccessTokenExpiresAt,
                        refreshTokenExpiresAt: refreshTokenExpiresAt,
                        refreshAfter: refreshAfter
                    )
                    connectToMac()

                case "denied":
                    stopPolling()
                    errorMessage = "Pairing was denied on your Assistant."
                    phase = .error

                case "expired":
                    stopPolling()
                    errorMessage = "Pairing request expired. Show a new QR code on your Assistant."
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

    private func savePairingConfig(bearerToken: String, gatewayUrl: String, hostId: String, localLanUrl: String?, actorToken: String? = nil, refreshToken: String? = nil, actorTokenExpiresAt: Int? = nil, refreshTokenExpiresAt: Int? = nil, refreshAfter: Int? = nil) {
        UserDefaults.standard.set(gatewayUrl, forKey: UserDefaultsKeys.gatewayBaseURL)
        _ = APIKeyManager.shared.setAPIKey(bearerToken, provider: "runtime-bearer-token")
        if !hostId.isEmpty {
            UserDefaults.standard.set(hostId, forKey: "gateway_host_id")
        }

        // Persist the JWT access token and refresh credentials received during pairing
        // so subsequent HTTP requests include the Authorization: Bearer header immediately.
        // When re-pairing to an assistant that omits the token, clear the
        // previous value so the old credential is never sent to the new gateway.
        if let actorToken = actorToken, !actorToken.isEmpty,
           let refreshToken = refreshToken,
           let actorTokenExpiresAt = actorTokenExpiresAt,
           let refreshTokenExpiresAt = refreshTokenExpiresAt,
           let refreshAfter = refreshAfter {
            ActorTokenManager.storeCredentials(
                actorToken: actorToken,
                actorTokenExpiresAt: actorTokenExpiresAt,
                refreshToken: refreshToken,
                refreshTokenExpiresAt: refreshTokenExpiresAt,
                refreshAfter: refreshAfter
            )
        } else if let actorToken = actorToken, !actorToken.isEmpty {
            ActorTokenManager.setToken(actorToken)
            ActorTokenManager.clearRefreshMetadata()
        } else {
            ActorTokenManager.deleteToken()
        }

        // Generate conversation key if missing
        if UserDefaults.standard.string(forKey: UserDefaultsKeys.conversationKey)?.isEmpty != false {
            UserDefaults.standard.set(UUID().uuidString, forKey: UserDefaultsKeys.conversationKey)
        }
    }

    private func connectToMac() {
        phase = .connecting
        clientProvider.rebuildClient()

        // If the pairing response did not include an access token, re-trigger
        // the credential loop so the device obtains one from the daemon now
        // that a valid gateway URL is configured. Without this, a fresh
        // install that pairs in-session would lack an access token until the
        // next app restart.
        if !ActorTokenManager.hasToken {
            if let appDelegate = UIApplication.shared.delegate as? AppDelegate {
                appDelegate.ensureActorCredentials()
            }
        }

        Task {
            do {
                try await clientProvider.client.connect()
                await MainActor.run {
                    phase = .connected
                }
            } catch {
                await MainActor.run {
                    errorMessage = "Couldn't connect to your Assistant."
                    failureReason = error.localizedDescription
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
