import Foundation
import SwiftUI
import VellumAssistantShared

/// Standalone gateway configuration card — local gateway target, gateway URL,
/// and connection status. Designed to be embedded in any settings tab.
@MainActor
struct GatewaySettingsCard: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var gatewayUrlText: String = ""
    @FocusState private var isGatewayUrlFocused: Bool
    @State private var gatewayTargetCopied: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Section header
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Gateway")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Local gateway that forwards requests to this assistant")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            // Local Gateway Target (read-only copyable address)
            Text("Local Gateway Target")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

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

            // Running badge — only shown when gateway is reachable
            if store.gatewayReachable == true {
                VButton(label: "Running", leftIcon: "checkmark.circle.fill", style: .success, size: .medium) {}
            }

            Text("Point your tunnel (ngrok, Cloudflare, etc.) to this address.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            // Gateway URL field
            Text("Gateway URL")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            HStack(spacing: VSpacing.sm) {
                TextField("https://your-tunnel.example.com", text: $gatewayUrlText)
                    .vInputStyle()
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .focused($isGatewayUrlFocused)

                // Tunnel status inline at end of URL row (only when URL is non-empty)
                if !gatewayUrlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    InlineConnectionStatus(
                        status: tunnelStatusInfo,
                        isRefreshing: store.isCheckingTunnel,
                        lastChecked: store.tunnelLastChecked,
                        accessibilityLabel: "tunnel"
                    ) {
                        Task { await store.testTunnelOnly() }
                    }
                }
            }

            // Save button at the bottom
            HStack {
                VButton(label: "Save", style: .secondary, size: .medium) {
                    store.saveIngressPublicBaseUrl(gatewayUrlText)
                    isGatewayUrlFocused = false
                }
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
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            store.refreshIngressConfig()
            gatewayUrlText = store.ingressPublicBaseUrl
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
    }

    // MARK: - Connection Status Helpers

    private var tunnelStatusInfo: ConnectionStatusInfo {
        let trimmedUrl = store.ingressPublicBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)

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
}
