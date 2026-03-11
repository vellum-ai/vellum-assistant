import Foundation
import SwiftUI
import VellumAssistantShared

/// Standalone gateway configuration card — local gateway target, gateway URL,
/// and connection status. Designed to be embedded in any settings tab.
@MainActor
struct GatewaySettingsCard: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    var isManaged: Bool = false

    @State private var gatewayUrlText: String = ""
    @FocusState private var isGatewayUrlFocused: Bool
    @State private var gatewayTargetCopied: Bool = false

    var body: some View {
        SettingsCard(
            title: "Gateway",
            subtitle: isManaged
                ? "Gateway that forwards requests to this assistant"
                : "Local gateway that forwards requests to this assistant"
        ) {
            if !isManaged {
                // Local Gateway Target (read-only copyable address)
                Text("Local Gateway Target")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.textSecondary)

                HStack(spacing: VSpacing.sm) {
                    Text(store.localGatewayTarget)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .textSelection(.enabled)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .frame(height: 28, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(VColor.inputBackground)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.surfaceBorder, lineWidth: 1)
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
                        VIconView(gatewayTargetCopied ? .check : .copy, size: 12)
                            .foregroundColor(gatewayTargetCopied ? VColor.success : VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy gateway address")
                    .help("Copy address")

                    // Retry button — always visible so user can recheck gateway status
                    Button {
                        Task { await store.testGatewayOnly() }
                    } label: {
                        SpinningRefreshIcon(isSpinning: store.isCheckingGateway)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Refresh gateway status")
                    .help(store.gatewayLastChecked != nil ? "Last checked: \(relativeGatewayTime)" : "Test gateway")
                }

                // Running badge — only shown when gateway is reachable
                if store.gatewayReachable == true {
                    VButton(label: "Running", leftIcon: VIcon.circleCheck.rawValue, style: .success, size: .medium) {}
                }

                Text("Point your tunnel (ngrok, Cloudflare, etc.) to this address.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            // Gateway URL field
            Text("Gateway URL")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            if isManaged {
                // For managed assistants, show the gateway URL as read-only
                Text(store.localGatewayTarget)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.xs)
                    .frame(height: 28, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VColor.inputBackground)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
            } else {
                HStack(spacing: VSpacing.sm) {
                    TextField("https://your-tunnel.example.com", text: $gatewayUrlText)
                        .vInputStyle()
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .focused($isGatewayUrlFocused)

                    Button {
                        Task { await store.testTunnelOnly() }
                    } label: {
                        SpinningRefreshIcon(isSpinning: store.isCheckingTunnel)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Refresh tunnel status")
                    .help(store.tunnelLastChecked != nil ? "Last checked: \(relativeTunnelTime)" : "Test tunnel")
                }

                // Save button at the bottom
                HStack {
                    VButton(label: "Save", style: .primary, size: .medium) {
                        store.saveIngressPublicBaseUrl(gatewayUrlText)
                        isGatewayUrlFocused = false
                    }
                }

                // Diagnostic message when gateway is up but tunnel is down
                if store.gatewayReachable == true,
                   !store.ingressPublicBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   store.ingressReachable == false {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.triangleAlert, size: 12)
                            .foregroundColor(VColor.warning)
                        Text("Gateway is running but tunnel is unreachable. Check your tunnel configuration.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.warning)
                    }
                }
            }
        }
        .onAppear {
            store.refreshIngressConfig()
            gatewayUrlText = store.ingressPublicBaseUrl
        }
        .onChange(of: store.ingressPublicBaseUrl) { _, newValue in
            if !isGatewayUrlFocused {
                gatewayUrlText = newValue
            }
        }
        .onChange(of: store.ingressConfigLoaded) { _, loaded in
            guard loaded else { return }
            Task { await store.testGatewayOnly() }
            Task { await store.testTunnelOnly() }
        }
    }

    // MARK: - Helpers

    private var relativeGatewayTime: String { relativeTime(from: store.gatewayLastChecked) }
    private var relativeTunnelTime: String { relativeTime(from: store.tunnelLastChecked) }

    private func relativeTime(from date: Date?) -> String {
        guard let date else { return "unknown" }
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds)s ago" }
        return "\(seconds / 60)m ago"
    }
}
