import CryptoKit
import SwiftUI
import VellumAssistantShared

/// Displays a QR code containing the v2 connection payload for iOS pairing.
/// Payload format: `{"type":"vellum-daemon","v":2,"id":"<mac-hash>","g":"<ingress-url>","bt":"<bearer-token>"}`
///
/// Below the QR code, shows the gateway URL and bearer token for manual entry on iOS.
@MainActor
struct PairingQRCodeSheet: View {
    @Environment(\.dismiss) var dismiss

    let ingressEnabled: Bool
    let gatewayUrl: String
    let resolvedBearerToken: String

    @State private var hostId: String = ""
    @State private var isTokenRevealed: Bool = false
    @State private var copiedField: String? = nil

    /// Whether the ingress configuration is sufficient for pairing.
    private var canGenerateQR: Bool {
        ingressEnabled && !gatewayUrl.isEmpty && !resolvedBearerToken.isEmpty
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
                    if !ingressEnabled || gatewayUrl.isEmpty {
                        Text("Enable ingress and set a public URL in Settings to pair with iOS")
                            .font(VFont.body)
                            .foregroundColor(VColor.error)
                            .multilineTextAlignment(.center)
                    } else {
                        Text("Bearer token not found. Restart the daemon to generate it.")
                            .font(VFont.body)
                            .foregroundColor(VColor.error)
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(width: 220, height: 220)
            }

            Text("Scan this QR code with the Vellum iOS app to connect.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            // Manual pairing info
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Manual Pairing")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .textCase(.uppercase)

                // Gateway URL row
                HStack {
                    Text("Gateway URL")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 90, alignment: .leading)
                    Text(gatewayUrl.isEmpty ? "Not configured" : gatewayUrl)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(gatewayUrl, forType: .string)
                        withAnimation { copiedField = "url" }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            withAnimation { if copiedField == "url" { copiedField = nil } }
                        }
                    } label: {
                        Text(copiedField == "url" ? "Copied" : "Copy")
                            .font(VFont.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(gatewayUrl.isEmpty)
                }

                Divider()

                // Bearer token row
                HStack {
                    Text("Bearer Token")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 90, alignment: .leading)
                    if resolvedBearerToken.isEmpty {
                        Text("Not available")
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                    } else if isTokenRevealed {
                        Text(resolvedBearerToken)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text(String(repeating: "\u{2022}", count: min(resolvedBearerToken.count, 24)))
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button {
                        isTokenRevealed.toggle()
                    } label: {
                        Image(systemName: isTokenRevealed ? "eye.slash" : "eye")
                            .font(VFont.caption)
                    }
                    .buttonStyle(.borderless)
                    .help(isTokenRevealed ? "Hide token" : "Reveal token")
                    .disabled(resolvedBearerToken.isEmpty)

                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(resolvedBearerToken, forType: .string)
                        withAnimation { copiedField = "token" }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            withAnimation { if copiedField == "token" { copiedField = nil } }
                        }
                    } label: {
                        Text(copiedField == "token" ? "Copied" : "Copy")
                            .font(VFont.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(resolvedBearerToken.isEmpty)
                }
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
        .frame(width: 380)
        .onAppear {
            hostId = Self.computeHostId()
        }
    }

    private func generateQRImage() -> NSImage? {
        guard canGenerateQR else { return nil }

        let payload: [String: Any] = [
            "type": "vellum-daemon",
            "v": 2,
            "id": hostId,
            "g": gatewayUrl,
            "bt": resolvedBearerToken,
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
