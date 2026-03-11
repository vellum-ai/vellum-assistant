import Foundation
import SwiftUI
import VellumAssistantShared

/// Channels settings tab — mobile device pairing UI.
/// Channel configuration cards (Telegram, Slack, Voice, Email) have moved to
/// the Contacts tab's AssistantChannelsDetailView.
@MainActor
struct SettingsChannelsTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var showingPairingQR: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            connectionsSection
        }
        .onAppear {
            store.refreshApprovedDevices()
        }
        .sheet(isPresented: $showingPairingQR) {
            PairingQRCodeSheet(
                gatewayUrl: store.resolvedIosGatewayUrl,
                daemonClient: daemonClient
            )
        }
    }

    // MARK: - Connections Section

    private var connectionsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            mobileCard
        }
    }

    // MARK: - Mobile Card (Pairing + Approved Devices)

    private var mobileCard: some View {
        SettingsCard(title: "Mobile (iOS)", subtitle: "Connect your phone to your assistant through the iOS app") {
            // Connected devices
            if !store.approvedDevices.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Devices")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)

                    ForEach(store.approvedDevices, id: \.hashedDeviceId) { device in
                        HStack(spacing: VSpacing.sm) {
                            VIconView(.smartphone, size: 12)
                                .foregroundColor(VColor.success)
                            Text(device.deviceName)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Button {
                                store.removeApprovedDevice(hashedDeviceId: device.hashedDeviceId)
                            } label: {
                                VIconView(.trash, size: 12)
                                    .foregroundColor(VColor.error)
                                    .padding(VSpacing.xs)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(device.deviceName)")
                            .pointerCursor()
                        }
                    }
                }
            }

            // Device pairing row
            mobilePairingRow
        }
    }

    @ViewBuilder
    private var mobilePairingRow: some View {
        let hasGateway = !store.resolvedIosGatewayUrl.isEmpty || LANIPHelper.currentLANAddress() != nil

        if !hasGateway {
            HStack(spacing: VSpacing.sm) {
                VIconView(.triangleAlert, size: 12)
                    .foregroundColor(VColor.warning)
                Text("Configure a gateway URL to enable pairing")
                    .font(VFont.body)
                    .foregroundColor(VColor.warning)
            }
        } else {
            VButton(label: "Pair Device", leftIcon: VIcon.qrCode.rawValue, style: .primary, size: .medium) {
                showingPairingQR = true
            }
        }
    }
}
