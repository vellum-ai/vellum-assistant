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
    @State private var tunnelSetupExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Gateway")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Local gateway that forwards requests to this assistant")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            // Gateway running status row
            if store.gatewayReachable == true {
                VButton(label: "Connected", leftIcon: "checkmark.circle.fill", style: .success, size: .medium) {}
                tunnelConfigEntry
            } else if tunnelSetupExpanded || !gatewayUrlText.isEmpty {
                tunnelConfigEntry
            } else {
                VButton(label: "Set Up", style: .secondary, size: .medium) {
                    tunnelSetupExpanded = true
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

    // MARK: - Tunnel Configuration Entry

    private var tunnelConfigEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
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
                Text("Point your tunnel (ngrok, Cloudflare, etc.) to this address.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            Text("Gateway URL")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            TextField("https://your-tunnel.example.com", text: $gatewayUrlText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .focused($isGatewayUrlFocused)

            HStack(spacing: VSpacing.sm) {
                VButton(label: "Save", style: .secondary, size: .medium) {
                    store.saveIngressPublicBaseUrl(gatewayUrlText)
                    isGatewayUrlFocused = false
                    tunnelSetupExpanded = false
                }
                // No .disabled() — empty URL is valid (clears the tunnel target)
                VButton(label: "Cancel", style: .tertiary, size: .medium) {
                    gatewayUrlText = store.ingressPublicBaseUrl
                    isGatewayUrlFocused = false
                    tunnelSetupExpanded = false
                }
            }
        }
    }
}
