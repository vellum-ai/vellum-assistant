import SwiftUI
import VellumAssistantShared

/// General settings tab — account/platform sign-in card followed by appearance settings.
@MainActor
struct SettingsGeneralTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    var authManager: AuthManager
    var onClose: () -> Void

    @State private var showingPairingQR: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            accountSection
            SettingsAppearanceTab(store: store, afterTimezone: AnyView(mobilePairingCard))
        }
        .onAppear {
            Task { await authManager.checkSession() }
            store.refreshApprovedDevices()
        }
        .sheet(isPresented: $showingPairingQR) {
            PairingQRCodeSheet(
                gatewayUrl: store.resolvedIosGatewayUrl,
                daemonClient: daemonClient
            )
        }
    }

    // MARK: - Mobile Pairing

    private var mobilePairingCard: some View {
        SettingsCard(title: "Mobile (iOS)", subtitle: "Connect your phone to your assistant through the iOS app") {
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
                            VIconButton(label: "Remove \(device.deviceName)", icon: VIcon.trash.rawValue, iconOnly: true, variant: .danger) {
                                store.removeApprovedDevice(hashedDeviceId: device.hashedDeviceId)
                            }
                        }
                    }
                }
            }

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

    // MARK: - Account Section

    private var accountSection: some View {
        SettingsCard(title: "Account", subtitle: "Sign in to Your Account") {
            if authManager.isLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Checking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if authManager.currentUser != nil {
                VButton(label: "Log Out", style: .danger, size: .medium) {
                    Task { await authManager.logout() }
                }
            } else {
                VButton(
                    label: authManager.isSubmitting ? "Signing in..." : "Sign In",
                    style: .primary,
                    size: .medium,
                    isDisabled: authManager.isSubmitting
                ) {
                    Task { await authManager.startWorkOSLogin() }
                }
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
    }
}
