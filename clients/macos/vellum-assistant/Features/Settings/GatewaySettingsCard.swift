import Foundation
import SwiftUI
import VellumAssistantShared

/// Standalone gateway configuration card — local gateway target, gateway URL,
/// connection status, and bearer token management. Designed to be embedded
/// in any settings tab.
@MainActor
struct GatewaySettingsCard: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var gatewayUrlText: String = ""
    @FocusState private var isGatewayUrlFocused: Bool
    @State private var bearerToken: String = ""
    @State private var tokenRevealed: Bool = false
    @State private var tokenCopied: Bool = false
    @State private var gatewayTargetCopied: Bool = false
    @State private var showingRegenerateConfirmation: Bool = false
    @State private var isRegeneratingToken: Bool = false
    @State private var refreshSpinning: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Gateway")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            gatewayContent
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
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
        .onChange(of: store.ingressConfigLoaded) { _, loaded in
            guard loaded else { return }
            Task { await store.testGatewayOnly() }
            Task { await store.testTunnelOnly() }
        }
        .alert("Regenerate Bearer Token", isPresented: $showingRegenerateConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Regenerate", role: .destructive) {
                regenerateHttpToken()
            }
        } message: {
            Text("This will generate a new security token and restart your assistant. Any paired devices will need to reconnect.")
        }
    }

    // MARK: - Gateway Content

    private var gatewayContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
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

            // Gateway connection status (checks local daemon)
            connectionStatusRow(
                label: "Gateway",
                status: gatewayStatusInfo,
                isRefreshing: store.isCheckingGateway,
                lastChecked: store.gatewayLastChecked
            ) {
                Task { await store.testGatewayOnly() }
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Gateway URL field
            HStack(spacing: VSpacing.xs) {
                Text("Gateway URL")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            HStack(spacing: VSpacing.sm) {
                TextField("https://your-tunnel.example.com", text: $gatewayUrlText)
                    .focused($isGatewayUrlFocused)
                    .vInputStyle()
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

                VButton(label: "Save", style: .primary) {
                    store.saveIngressPublicBaseUrl(gatewayUrlText)
                }
            }

            // Tunnel connection status (checks public URL)
            connectionStatusRow(
                label: "Tunnel",
                status: tunnelStatusInfo,
                isRefreshing: store.isCheckingTunnel,
                lastChecked: store.tunnelLastChecked
            ) {
                Task { await store.testTunnelOnly() }
            }

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

            Divider()
                .background(VColor.surfaceBorder)

            bearerTokenContent
        }
    }

    // MARK: - Bearer Token Content

    private var bearerTokenContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Bearer Token")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textSecondary)

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
            // valid — fall through to further checks below
        } else {
            return ConnectionStatusInfo(label: "Invalid URL format", color: VColor.error, icon: "exclamationmark.circle.fill")
        }

        // URL is set but ingress is disabled
        if !store.ingressEnabled {
            return ConnectionStatusInfo(label: "URL set but gateway not active", color: VColor.warning, icon: "exclamationmark.triangle.fill")
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

    private func connectionStatusRow(
        label: String,
        status: ConnectionStatusInfo,
        isRefreshing: Bool = false,
        lastChecked: Date? = nil,
        onRefresh: (() -> Void)? = nil
    ) -> some View {
        let spinning = isRefreshing || refreshSpinning.contains(label)

        return HStack(spacing: VSpacing.sm) {
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

            if let onRefresh {
                let tooltipText: String = {
                    if spinning { return "Checking..." }
                    if let lastChecked { return "Last verified: \(relativeTimeString(from: lastChecked))" }
                    return "Test connection"
                }()

                Button {
                    guard !spinning else { return }
                    refreshSpinning.insert(label)
                    onRefresh()
                    Task {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        refreshSpinning.remove(label)
                    }
                } label: {
                    SpinningRefreshIcon(isSpinning: spinning)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh \(label) status")
                .help(tooltipText)
            }

            Spacer()
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

    // MARK: - Spinning Refresh Icon

    private struct SpinningRefreshIcon: View {
        let isSpinning: Bool

        @State private var angle: Double = 0

        var body: some View {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(isSpinning ? VColor.accent : VColor.textMuted)
                .rotationEffect(.degrees(angle))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
                .task(id: isSpinning) {
                    if isSpinning {
                        angle = 0
                        while !Task.isCancelled {
                            withAnimation(.linear(duration: 1)) {
                                angle += 360
                            }
                            try? await Task.sleep(nanoseconds: 1_000_000_000)
                        }
                    } else {
                        angle = 0
                    }
                }
        }
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
        isRegeneratingToken = true
        let pidPath = resolvePidPath()
        if let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr) {
            kill(pid, SIGTERM)
        }
        // Wait for the daemon to restart and become reachable with the new token.
        Task {
            let base = store.localGatewayTarget.hasSuffix("/")
                ? String(store.localGatewayTarget.dropLast())
                : store.localGatewayTarget
            guard let url = URL(string: "\(base)/v1/health") else {
                isRegeneratingToken = false
                return
            }
            var request = URLRequest(url: url)
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 2
            for _ in 0..<30 { // up to ~30s
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if let (_, response) = try? await URLSession.shared.data(for: request),
                   let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    isRegeneratingToken = false
                    return
                }
            }
            isRegeneratingToken = false
        }
    }
}
