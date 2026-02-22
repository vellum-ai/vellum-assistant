import CryptoKit
import SwiftUI
import VellumAssistantShared

/// Displays a QR code containing the connection payload for iOS pairing.
/// Payload format: `{"type":"vellum-daemon","h":"<ip>","p":8765,"t":"<token>","f":"<fingerprint>","id":"<mac-hash>","v":1}`
@MainActor
struct PairingQRCodeSheet: View {
    @Environment(\.dismiss) var dismiss

    let sessionToken: String
    let fingerprint: String
    let tcpPort: Int

    @State private var localIP: String = "..."
    @State private var hostId: String = ""

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            HStack {
                Text("Pair iOS Device")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Button("Done") { dismiss() }
            }

            if let qrImage = generateQRImage() {
                Image(nsImage: qrImage)
                    .resizable()
                    .interpolation(.none)
                    .scaledToFit()
                    .frame(width: 220, height: 220)
                    .padding(VSpacing.md)
                    .background(Color.white)
                    .cornerRadius(VRadius.md)
            } else {
                Text("Failed to generate QR code")
                    .font(VFont.body)
                    .foregroundColor(VColor.error)
                    .frame(width: 220, height: 220)
            }

            Text("Scan this QR code with the Vellum iOS app to connect.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                infoRow(label: "IP Address", value: localIP)
                infoRow(label: "Port", value: "\(tcpPort)")
                infoRow(label: "TLS", value: "Enabled")
            }
            .padding(VSpacing.md)
            .background(VColor.surfaceSubtle)
            .cornerRadius(VRadius.md)

            Text("Pairing persists until you regenerate the session token.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(VSpacing.xl)
        .frame(width: 340)
        .onAppear {
            localIP = NetworkInterfaceResolver.getLocalIPv4() ?? "unknown"
            hostId = Self.computeHostId()
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
            Spacer()
        }
    }

    private func generateQRImage() -> NSImage? {
        guard localIP != "..." && localIP != "unknown" else { return nil }

        let payload: [String: Any] = [
            "type": "vellum-daemon",
            "h": localIP,
            "p": tcpPort,
            "t": sessionToken,
            "f": fingerprint,
            "id": hostId,
            "v": 1,
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            return nil
        }

        return QRCodeGenerator.generate(from: jsonString, size: 220)
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
