import SwiftUI
import VellumAssistantShared

/// General settings tab — account/platform sign-in card.
@MainActor
struct SettingsGeneralTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    var authManager: AuthManager
    var onClose: () -> Void
    var showToast: ((String, ToastInfo.Style) -> Void)?
    var onSignIn: (() -> Void)?

    @State private var showingPairingQR: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            accountSection
            if MacOSClientFeatureFlagManager.shared.isEnabled("mobile_pairing_enabled") {
                mobilePairingCard
            }
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
                        .foregroundColor(VColor.contentSecondary)

                    ForEach(store.approvedDevices, id: \.hashedDeviceId) { device in
                        HStack(spacing: VSpacing.sm) {
                            VIconView(.smartphone, size: 12)
                                .foregroundColor(VColor.systemPositiveStrong)
                            Text(device.deviceName)
                                .font(VFont.body)
                                .foregroundColor(VColor.contentSecondary)
                            VButton(label: "Remove \(device.deviceName)", iconOnly: VIcon.trash.rawValue, style: .danger) {
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
                        .foregroundColor(VColor.systemNegativeHover)
                    Text("Configure a gateway URL to enable pairing")
                        .font(VFont.body)
                        .foregroundColor(VColor.systemNegativeHover)
                }
            } else {
                VButton(label: "Pair Device", leftIcon: VIcon.qrCode.rawValue, style: .primary) {
                    showingPairingQR = true
                }
            }
        }
    }

    // MARK: - Account Section

    private var accountSection: some View {
        SettingsCard(
            title: "Account",
            subtitle: authManager.currentUser?.email ?? authManager.currentUser?.display ?? "Log in to your account"
        ) {
            if authManager.isLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Checking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            } else if authManager.currentUser != nil {
                VButton(label: "Log Out", style: .danger) {
                    AppDelegate.shared?.performLogout()
                }
            } else {
                VButton(
                    label: authManager.isSubmitting ? "Logging in..." : "Log In",
                    style: .primary,
                    isDisabled: authManager.isSubmitting
                ) {
                    Task {
                        if let showToast {
                            await authManager.loginWithToast(showToast: showToast, onSuccess: { onSignIn?() })
                        } else {
                            await authManager.startWorkOSLogin()
                            if authManager.isAuthenticated { onSignIn?() }
                        }
                    }
                }
            }
        }
    }
}
