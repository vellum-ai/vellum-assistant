import CryptoKit
import SwiftUI
import VellumAssistantShared

/// Displays a QR code containing the v4 connection payload for iOS pairing.
///
/// v4 payload:
/// `{"type":"vellum-daemon","v":4,"id":"<mac-hash>","g":"<gateway-url>","pairingRequestId":"<uuid>","<redacted>":"<redacted>"}`
///
/// Key differences from v3:
/// - No bearer token in QR code (secured by pairing secret + Mac approval)
/// - Includes pairingRequestId + pairingSecret for the handshake
/// - Pre-registers the pairing request with the daemon via local HTTP
/// - localLanUrl is opt-in for explicit development/testing only
@MainActor
struct PairingQRCodeSheet: View {
    @Environment(\.dismiss) var dismiss

    let gatewayUrl: String
    let daemonClient: DaemonClient?

    @State private var hostId: String = ""
    @State private var pairingRequestId: String = UUID().uuidString
    @State private var pairingSecret: String = generatePairingSecret()
    @State private var localLanUrl: String? = nil
    @State private var registrationState: RegistrationState = .idle
    @State private var registrationError: String? = nil
    @State private var refreshTask: Task<Void, Never>? = nil
    @State private var consecutiveRefreshFailures: Int = 0

    /// Re-register every 4 minutes to stay ahead of the 5-minute TTL.
    private static let refreshInterval: UInt64 = 4 * 60 * 1_000_000_000

    enum RegistrationState {
        case idle, registering, registered, failed
    }

    /// The effective gateway URL for iOS to connect to. Prefers the configured
    /// cloud gateway URL, falls back to the local LAN gateway address.
    private var effectiveGatewayUrl: String {
        if !gatewayUrl.isEmpty { return gatewayUrl }
        return localLanUrl ?? ""
    }

    /// Whether the configuration is sufficient for pairing.
    private var canGenerateQR: Bool {
        !effectiveGatewayUrl.isEmpty && registrationState == .registered
    }

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            HStack {
                Text("Pair iOS Device")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                Button("Done") { dismiss() }
            }

            if daemonClient == nil {
                errorContent("Cannot generate QR code \u{2014} daemon not connected. Please wait for the daemon to start and try again.")
            } else {
                switch registrationState {
                case .idle, .registering:
                    VStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.large)
                        Text("Registering pairing request...")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .frame(width: 220, height: 220)

                case .registered:
                    if let qrImage = generateQRImage() {
                        Image(nsImage: qrImage)
                            .resizable()
                            .interpolation(.none)
                            .scaledToFit()
                            .frame(width: 220, height: 220)
                            .padding(VSpacing.md)
                            .background(VColor.auxWhite)
                            .cornerRadius(VRadius.md)
                    } else {
                        errorContent("Failed to generate QR code.")
                    }

                case .failed:
                    errorContent(registrationError ?? "Could not register pairing request. Ensure the daemon is running.")
                }

                // State indicator
                if canGenerateQR {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.circleCheck, size: 14)
                            .foregroundColor(VColor.systemPositiveStrong)
                        Text("Ready to pair with iOS")
                            .font(VFont.body)
                            .foregroundColor(VColor.systemPositiveStrong)
                    }

                    if localLanUrl != nil {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.wifi, size: 12)
                                .foregroundColor(VColor.contentTertiary)
                            Text("LAN pairing available")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }

            Text("Scan this QR code with the Vellum iOS app. You will be asked to approve the pairing on this Mac.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)

            if registrationState == .failed && daemonClient != nil {
                Button("Retry") {
                    consecutiveRefreshFailures = 0
                    pairingRequestId = UUID().uuidString
                    pairingSecret = Self.generatePairingSecret()
                    registerWithDaemon()
                    startRefreshTimer()
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 380)
        .onAppear {
            hostId = Self.computeHostId()
            localLanUrl = shouldAdvertiseLocalLanUrl ? computeLocalLanUrl() : nil
            guard daemonClient != nil else { return }
            registerWithDaemon()
            startRefreshTimer()
        }
        .onDisappear {
            stopRefreshTimer()
        }
    }

    private func errorContent(_ message: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 32)
                .foregroundColor(VColor.systemNegativeStrong)
            Text(message)
                .font(VFont.body)
                .foregroundColor(VColor.systemNegativeStrong)
                .multilineTextAlignment(.center)
        }
        .frame(width: 220, height: 220)
    }

    // MARK: - Refresh Timer

    private func startRefreshTimer() {
        stopRefreshTimer()
        refreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.refreshInterval)
                guard !Task.isCancelled else { break }
                // Generate new credentials into locals so the old QR stays visible
                // while the re-registration HTTP request is in-flight.
                let newRequestId = UUID().uuidString
                let newSecret = Self.generatePairingSecret()
                await refreshRegistration(newRequestId: newRequestId, newSecret: newSecret)
            }
        }
    }

    private func stopRefreshTimer() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    // MARK: - Registration

    /// Resolve the local gateway base URL: env var > lockfile > default 7830.
    private var resolvedGatewayBaseUrl: String {
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        return "http://127.0.0.1:\(LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId))"
    }

    private func registerWithDaemon() {
        registrationState = .registering
        registrationError = nil

        let baseUrl = resolvedGatewayBaseUrl

        let reqId = pairingRequestId
        let secret = pairingSecret

        Task {
            let result = await performRegistrationRequest(gatewayBaseUrl: baseUrl, requestId: reqId, secret: secret)
            switch result {
            case .success:
                registrationState = .registered
            case .failure(let error):
                registrationState = .failed
                registrationError = error.message
            }
        }
    }

    /// Re-register with new credentials without disrupting the visible QR code.
    /// Only swaps pairingRequestId, pairingSecret, and registrationState atomically
    /// once the HTTP 200 response comes back. On failure the old QR stays visible.
    private func refreshRegistration(newRequestId: String, newSecret: String) async {
        let baseUrl = resolvedGatewayBaseUrl

        let result = await performRegistrationRequest(gatewayBaseUrl: baseUrl, requestId: newRequestId, secret: newSecret)
        switch result {
        case .success:
            pairingRequestId = newRequestId
            pairingSecret = newSecret
            registrationState = .registered
            consecutiveRefreshFailures = 0
        case .failure:
            consecutiveRefreshFailures += 1
            if consecutiveRefreshFailures >= 2 {
                registrationState = .failed
                registrationError = "Re-registration failed. Close and reopen to try again."
                stopRefreshTimer()
            }
            // On first failure, keep old QR visible; the next timer tick will retry.
        }
    }

    /// Error wrapper for registration request results.
    private struct RegistrationRequestError: Error {
        let message: String
    }

    /// Shared HTTP request logic for pairing registration.
    /// Awaits token availability to handle the bootstrap window where the JWT
    /// is being re-issued after a credential clear.
    private func performRegistrationRequest(gatewayBaseUrl: String, requestId: String, secret: String) async -> Result<Void, RegistrationRequestError> {
        let bearerToken = await ActorTokenManager.waitForToken(timeout: 10)

        let url = URL(string: "\(gatewayBaseUrl)/pairing/register")!

        var body: [String: Any] = [
            "pairingRequestId": requestId,
            "pairingSecret": secret,
            "gatewayUrl": effectiveGatewayUrl,
        ]
        if let lan = localLanUrl {
            body["localLanUrl"] = lan
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            return .failure(RegistrationRequestError(message: "Failed to serialize registration payload."))
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = jsonData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = bearerToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                return .success(())
            } else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                return .failure(RegistrationRequestError(message: "Registration failed (HTTP \(statusCode))."))
            }
        } catch {
            return .failure(RegistrationRequestError(message: "Could not reach daemon: \(error.localizedDescription)"))
        }
    }

    private func computeLocalLanUrl() -> String? {
        guard let lanIP = LANIPHelper.currentLANAddress() else { return nil }
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        return "http://\(lanIP):\(LockfilePaths.resolveGatewayPort(connectedAssistantId: connectedId))"
    }

    /// LAN pairing uses plaintext HTTP and can expose bearer tokens on a local
    /// network. Keep this disabled by default and only allow explicit opt-in
    /// for development/testing via environment variable.
    private var shouldAdvertiseLocalLanUrl: Bool {
        let value = ProcessInfo.processInfo.environment["VELLUM_ENABLE_INSECURE_LAN_PAIRING"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return value == "1" || value == "true" || value == "yes"
    }

    // MARK: - QR Generation

    private func generateQRImage() -> NSImage? {
        guard canGenerateQR else { return nil }

        var payload: [String: Any] = [
            "type": "vellum-daemon",
            "v": 4,
            "id": hostId,
            "g": effectiveGatewayUrl,
            "pairingRequestId": pairingRequestId,
            "pairingSecret": pairingSecret,
        ]

        if let lan = localLanUrl {
            payload["localLanUrl"] = lan
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            return nil
        }

        return QRCodeGenerator.generate(from: jsonString, size: 220)
    }

    static func generatePairingSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Compute a stable, privacy-safe host identifier.
    /// SHA-256 of the IOPlatformUUID + an app-specific salt.
    static func computeHostId() -> String {
        let platformUUID = getPlatformUUID() ?? UUID().uuidString
        let salt = "vellum-assistant-host-id"
        let input = Data((platformUUID + salt).utf8)
        let hash = SHA256.hash(data: input)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    /// Read the IOPlatformUUID from the IORegistry (macOS hardware identifier).
    private static func getPlatformUUID() -> String? {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }

        let key = kIOPlatformUUIDKey as CFString
        guard let uuid = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String else {
            return nil
        }
        return uuid
    }
}
