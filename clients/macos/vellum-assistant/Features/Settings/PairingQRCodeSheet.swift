import CryptoKit
import SwiftUI
import VellumAssistantShared

/// Displays a QR code containing the v2 connection payload for iOS pairing.
/// Payload format: `{"type":"vellum-daemon","v":2,"id":"<mac-hash>","g":"<ingress-url>","bt":"<bearer-token>"}`
@MainActor
struct PairingQRCodeSheet: View {
    @Environment(\.dismiss) var dismiss

    let ingressEnabled: Bool
    let ingressPublicBaseUrl: String

    @State private var hostId: String = ""
    @State private var bearerToken: String = ""

    /// Whether the ingress configuration is sufficient for pairing.
    private var canGenerateQR: Bool {
        ingressEnabled && !ingressPublicBaseUrl.isEmpty && !bearerToken.isEmpty
    }

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            HStack {
                Text("Pair iOS Device")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Button("Done") { dismiss() }
            }

            if canGenerateQR, let qrImage = generateQRImage() {
                Image(nsImage: qrImage)
                    .resizable()
                    .interpolation(.none)
                    .scaledToFit()
                    .frame(width: 220, height: 220)
                    .padding(VSpacing.md)
                    .background(Color.white)
                    .cornerRadius(VRadius.md)
            } else {
                VStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(VColor.error)
                    Text("Enable ingress and set a public URL in Settings to pair with iOS")
                        .font(VFont.body)
                        .foregroundColor(VColor.error)
                        .multilineTextAlignment(.center)
                }
                .frame(width: 220, height: 220)
            }

            Text("Scan this QR code with the Vellum iOS app to connect.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                infoRow(label: "Gateway URL", value: ingressPublicBaseUrl.isEmpty ? "Not configured" : ingressPublicBaseUrl)
                infoRow(label: "Ingress", value: ingressEnabled ? "Enabled" : "Disabled")
            }
            .padding(VSpacing.md)
            .background(VColor.surfaceSubtle)
            .cornerRadius(VRadius.md)

            Text("Pairing persists until you regenerate the bearer token.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(VSpacing.xl)
        .frame(width: 340)
        .onAppear {
            hostId = Self.computeHostId()
            bearerToken = Self.readBearerToken()
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 90, alignment: .leading)
            Text(value)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
        }
    }

    private func generateQRImage() -> NSImage? {
        guard canGenerateQR else { return nil }

        let payload: [String: Any] = [
            "type": "vellum-daemon",
            "v": 2,
            "id": hostId,
            "g": ingressPublicBaseUrl,
            "bt": bearerToken,
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            return nil
        }

        return QRCodeGenerator.generate(from: jsonString, size: 220)
    }

    /// Read the HTTP bearer token from ~/.vellum/http-token (same file the gateway uses).
    private static func readBearerToken() -> String {
        let tokenPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum/http-token").path
        return (try? String(contentsOfFile: tokenPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
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
            kIOMasterPortDefault,
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
