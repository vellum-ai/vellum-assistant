import Foundation
import SwiftUI
import VellumAssistantShared

/// Connect settings tab — centralized Gateway URL, Bearer Token, and QR pairing UI.
/// This is the single source of truth for configuring how devices and integrations
/// reach this Mac.
@MainActor
struct SettingsConnectTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var gatewayUrlText: String = ""
    @FocusState private var isGatewayUrlFocused: Bool
    @State private var bearerToken: String = ""
    @State private var tokenRevealed: Bool = false
    @State private var tokenCopied: Bool = false
    @State private var gatewayTargetCopied: Bool = false
    @State private var showingPairingQR: Bool = false
    @State private var showingRegenerateConfirmation: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            gatewaySection
            bearerTokenSection
            pairingSection
            statusSection
        }
        .onAppear {
            store.refreshIngressConfig()
            gatewayUrlText = store.ingressPublicBaseUrl
            refreshBearerToken()
        }
        .onChange(of: store.ingressPublicBaseUrl) { _, newValue in
            if !isGatewayUrlFocused {
                gatewayUrlText = newValue
            }
        }
        .onChange(of: isGatewayUrlFocused) { _, focused in
            if !focused {
                gatewayUrlText = store.ingressPublicBaseUrl
            }
        }
        .alert("Regenerate Bearer Token", isPresented: $showingRegenerateConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Regenerate", role: .destructive) {
                regenerateHttpToken()
            }
        } message: {
            Text("This will replace the current bearer token and restart the daemon. Any paired devices will need to reconnect.")
        }
        .sheet(isPresented: $showingPairingQR) {
            PairingQRCodeSheet(
                ingressEnabled: store.ingressEnabled,
                ingressPublicBaseUrl: store.ingressPublicBaseUrl
            )
        }
    }

    // MARK: - Gateway Section

    private var gatewaySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Gateway & Pairing")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Gateway URL field
            HStack(spacing: VSpacing.xs) {
                Text("Gateway URL")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            TextField("https://your-tunnel.example.com", text: $gatewayUrlText)
                .focused($isGatewayUrlFocused)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            VButton(label: "Save", style: .primary) {
                store.saveIngressPublicBaseUrl(gatewayUrlText)
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Local Gateway Target (read-only)
            HStack(spacing: VSpacing.xs) {
                Text("Local Gateway Target")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            HStack(spacing: VSpacing.sm) {
                Text(store.localGatewayTarget)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)
                    .textSelection(.enabled)
                    .padding(VSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VColor.surface.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder.opacity(0.3), lineWidth: 1)
                    )

                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(store.localGatewayTarget, forType: .string)
                    gatewayTargetCopied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        gatewayTargetCopied = false
                    }
                } label: {
                    Image(systemName: gatewayTargetCopied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(gatewayTargetCopied ? VColor.success : VColor.textSecondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy gateway address")
                .help("Copy address")
            }

            Text("Point your tunnel (ngrok, Cloudflare, etc.) to this address.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Bearer Token Section

    private var bearerTokenSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Bearer Token")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if bearerToken.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Bearer token not found. Restart the daemon to generate it.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    // Masked or revealed token
                    if tokenRevealed {
                        Text(bearerToken)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text(String(repeating: "\u{2022}", count: min(bearerToken.count, 24)))
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                    }

                    Spacer()

                    // Reveal/hide toggle
                    Button {
                        tokenRevealed.toggle()
                    } label: {
                        Image(systemName: tokenRevealed ? "eye.slash" : "eye")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tokenRevealed ? "Hide token" : "Reveal token")
                    .help(tokenRevealed ? "Hide token" : "Reveal token")

                    // Copy button
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(bearerToken, forType: .string)
                        tokenCopied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            tokenCopied = false
                        }
                    } label: {
                        Image(systemName: tokenCopied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(tokenCopied ? VColor.success : VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy bearer token")
                    .help("Copy token")

                    // Regenerate button
                    Button("Regenerate") {
                        showingRegenerateConfirmation = true
                    }
                    .font(VFont.caption)
                    .foregroundColor(VColor.accent)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Pairing Section

    private var pairingSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("QR Pairing")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Pair an iOS device")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Generate a QR code for the Vellum iOS app to scan.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VButton(label: "Show QR Code", style: .primary) {
                    showingPairingQR = true
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Status Section

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Status")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if store.ingressPublicBaseUrl.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 14))
                    Text("Set a Gateway URL to enable devices and integrations.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text("Configured")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            Text("This URL is used by your devices and integrations to reach this Mac.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Token Helpers

    private func refreshBearerToken() {
        bearerToken = readHttpToken() ?? ""
    }

    private func regenerateHttpToken() {
        let tokenPath = resolveHttpTokenPath()
        // Generate new random bytes before deleting the old file so a
        // SecRandomCopyBytes failure doesn't leave us with no token at all.
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return }
        let newToken = bytes.map { String(format: "%02x", $0) }.joined()
        try? FileManager.default.removeItem(atPath: tokenPath)
        let dir = (tokenPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: tokenPath, contents: Data(newToken.utf8), attributes: [.posixPermissions: 0o600])
        bearerToken = newToken
        // Kill the daemon so the health monitor restarts it with the new token.
        // The daemon only reads the token at startup, so a restart is required.
        let pidPath = NSHomeDirectory() + "/.vellum/vellum.pid"
        if let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr) {
            kill(pid, SIGTERM)
        }
    }
}
