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
            testConnectionSection
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
            } else if !store.ingressEnabled {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 14))
                    Text("Gateway URL is set but ingress is disabled. Enable ingress in Advanced settings to allow pairing.")
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

    // MARK: - Test Connection Section

    private var testConnectionSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Test Connection")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Test Connection button
            HStack(spacing: VSpacing.sm) {
                if store.isCheckingGateway {
                    VLoadingIndicator(size: 14, color: VColor.accent)
                    Text("Checking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                } else {
                    VButton(
                        label: "Test Connection",
                        leftIcon: "antenna.radiowaves.left.and.right",
                        style: .secondary,
                        isDisabled: store.isCheckingGateway
                    ) {
                        Task { await store.testGatewayConnection() }
                    }
                }
            }

            // Gateway status row
            connectionStatusRow(
                label: "Gateway",
                status: gatewayStatusInfo
            )

            // Tunnel status row
            connectionStatusRow(
                label: "Tunnel",
                status: tunnelStatusInfo
            )

            // Diagnostic message when gateway is up but tunnel is down
            if store.gatewayReachable == true,
               !store.ingressPublicBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               store.ingressReachable == false {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Gateway is running but tunnel is unreachable. Check your tunnel configuration.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.warning)
                }
            }

            // Last verified timestamp
            if let lastChecked = store.gatewayLastChecked {
                Text("Last verified: \(relativeTimeString(from: lastChecked))")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            // Helper text
            Text("Gateway checks the local process. Tunnel checks the public URL.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Connection Status Helpers

    private struct ConnectionStatusInfo {
        let label: String
        let color: Color
        let icon: String
    }

    private var gatewayStatusInfo: ConnectionStatusInfo {
        guard let reachable = store.gatewayReachable else {
            return ConnectionStatusInfo(label: "Unknown", color: VColor.textMuted, icon: "questionmark.circle.fill")
        }
        if reachable {
            return ConnectionStatusInfo(label: "Running", color: VColor.success, icon: "checkmark.circle.fill")
        } else {
            return ConnectionStatusInfo(label: "Stopped", color: VColor.error, icon: "xmark.circle.fill")
        }
    }

    private var tunnelStatusInfo: ConnectionStatusInfo {
        let trimmedUrl = store.ingressPublicBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)

        // No URL configured
        if trimmedUrl.isEmpty {
            return ConnectionStatusInfo(label: "Not configured", color: VColor.textMuted, icon: "minus.circle.fill")
        }

        // URL is non-empty but not a valid absolute HTTP(S) URL
        if let parsed = URL(string: trimmedUrl), let scheme = parsed.scheme, ["http", "https"].contains(scheme.lowercased()) {
            // valid — fall through to reachability check below
        } else {
            return ConnectionStatusInfo(label: "Invalid URL format", color: VColor.error, icon: "exclamationmark.circle.fill")
        }

        // Haven't tested yet
        guard let reachable = store.ingressReachable else {
            return ConnectionStatusInfo(label: "Unknown", color: VColor.textMuted, icon: "questionmark.circle.fill")
        }

        if reachable {
            return ConnectionStatusInfo(label: "Reachable", color: VColor.success, icon: "checkmark.circle.fill")
        } else {
            return ConnectionStatusInfo(label: "Unreachable", color: VColor.error, icon: "xmark.circle.fill")
        }
    }

    private func connectionStatusRow(label: String, status: ConnectionStatusInfo) -> some View {
        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 60, alignment: .leading)

            Image(systemName: status.icon)
                .foregroundColor(status.color)
                .font(.system(size: 12))

            Text(status.label)
                .font(VFont.body)
                .foregroundColor(status.color)
        }
    }

    /// Returns a human-readable relative time string (e.g. "just now", "2 minutes ago").
    private func relativeTimeString(from date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds) seconds ago" }
        let minutes = seconds / 60
        if minutes == 1 { return "1 minute ago" }
        if minutes < 60 { return "\(minutes) minutes ago" }
        let hours = minutes / 60
        if hours == 1 { return "1 hour ago" }
        return "\(hours) hours ago"
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
        let pidPath = resolvePidPath()
        if let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr) {
            kill(pid, SIGTERM)
        }
    }
}
