import Combine
import SwiftUI
import VellumAssistantShared

/// General settings tab — account/platform login card followed by appearance settings.
@MainActor
struct SettingsGeneralTab: View {
    @ObservedObject var store: SettingsStore
    var connectionManager: GatewayConnectionManager?
    var authManager: AuthManager
    var onClose: () -> Void
    var showToast: (String, ToastInfo.Style) -> Void
    var onSignIn: (() -> Void)?

    @State private var showingPairingQR: Bool = false

    // -- Software Update state --
    @State private var healthz: DaemonHealthz?
    @State private var isDockerOperationInProgress = false
    @State private var dockerOperationLabel: String = ""
    @State private var sparkleUpdateAvailable: Bool = false
    @State private var sparkleUpdateVersion: String?
    @State private var isServiceGroupUpdateInProgress = false
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""
    @State private var dockerOperationTimedOut = false
    @State private var dockerOperationTimeoutTask: Task<Void, Never>?
    @State private var healthzLoaded = false

    /// Publisher for reactive observation of connectionManager's isUpdateInProgress.
    /// Falls back to a single `false` emission when connectionManager is nil.
    private var updateInProgressPublisher: AnyPublisher<Bool, Never> {
        if let cm = connectionManager {
            return cm.$isUpdateInProgress.eraseToAnyPublisher()
        }
        return Just(false).eraseToAnyPublisher()
    }

    /// Derive the topology for the currently selected assistant.
    private var topology: AssistantTopology {
        guard let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) else {
            return .local
        }
        return assistant.isDocker ? .docker
            : assistant.isManaged ? .managed
            : assistant.cloud.lowercased() == "local" ? .local
            : .remote
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            accountSection
            if !lockfileAssistants.isEmpty {
                AssistantUpgradeSection(
                    currentVersion: connectionManager?.assistantVersion ?? healthz?.version,
                    topology: topology,
                    isDockerOperationInProgress: $isDockerOperationInProgress,
                    dockerOperationLabel: $dockerOperationLabel,
                    sparkleUpdateAvailable: sparkleUpdateAvailable,
                    sparkleUpdateVersion: sparkleUpdateVersion,
                    isServiceGroupUpdateInProgress: isServiceGroupUpdateInProgress,
                    healthzLoaded: healthzLoaded
                )
            }
            if MacOSClientFeatureFlagManager.shared.isEnabled("mobile_pairing_enabled") {
                mobilePairingCard
            }
            SettingsAppearanceTab(store: store)
            uninstallSection
        }
        .onAppear {
            Task { await authManager.checkSession() }
            store.refreshApprovedDevices()
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
            sparkleUpdateAvailable = AppDelegate.shared?.updateManager.isUpdateAvailable ?? false
            sparkleUpdateVersion = AppDelegate.shared?.updateManager.availableUpdateVersion
            Task { await fetchHealthz() }
        }
        .onReceive(updateInProgressPublisher) { inProgress in
            isServiceGroupUpdateInProgress = inProgress
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            sparkleUpdateAvailable = AppDelegate.shared?.updateManager.isUpdateAvailable ?? false
            sparkleUpdateVersion = AppDelegate.shared?.updateManager.availableUpdateVersion
        }
        .sheet(isPresented: $showingPairingQR) {
            PairingQRCodeSheet(
                gatewayUrl: store.resolvedIosGatewayUrl,
                connectionManager: connectionManager
            )
        }
        .sheet(isPresented: $isDockerOperationInProgress) {
            VStack(spacing: VSpacing.lg) {
                if dockerOperationTimedOut {
                    VIconView(.triangleAlert, size: 28)
                        .foregroundStyle(VColor.systemMidStrong)
                    Text("This is taking longer than expected")
                        .font(VFont.bodyMedium)
                        .foregroundStyle(VColor.contentDefault)
                    Text(dockerOperationLabel)
                        .font(VFont.caption)
                        .foregroundStyle(VColor.contentTertiary)
                    VButton(label: "Dismiss", style: .outlined) {
                        isDockerOperationInProgress = false
                    }
                } else {
                    ProgressView()
                        .controlSize(.regular)
                        .progressViewStyle(.circular)
                    Text(dockerOperationLabel)
                        .font(VFont.bodyMedium)
                        .foregroundStyle(VColor.contentDefault)
                    Text("This may take a minute. The assistant will be briefly unavailable.")
                        .font(VFont.caption)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            .padding(VSpacing.xxl)
            .frame(minWidth: 260)
            .interactiveDismissDisabled(!dockerOperationTimedOut)
            .onAppear {
                dockerOperationTimedOut = false
                dockerOperationTimeoutTask = Task {
                    try? await Task.sleep(nanoseconds: 3 * 60 * 1_000_000_000)
                    if !Task.isCancelled {
                        dockerOperationTimedOut = true
                    }
                }
            }
            .onDisappear {
                dockerOperationTimeoutTask?.cancel()
                dockerOperationTimeoutTask = nil
                dockerOperationTimedOut = false
            }
        }
    }

    // MARK: - Software Update

    private func fetchHealthz() async {
        guard !selectedAssistantId.isEmpty else { return }
        do {
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "assistants/\(selectedAssistantId)/healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            healthz = decoded ?? DaemonHealthz()
        } catch {
            healthz = DaemonHealthz()
        }
        healthzLoaded = true
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

    // MARK: - Uninstall

    private var uninstallSection: some View {
        SettingsCard(
            title: "Uninstall",
            subtitle: "Stops all assistants, archives your data, and moves Vellum to the Trash"
        ) {
            VButton(label: "Uninstall Vellum...", style: .danger) {
                AppDelegate.shared?.performUninstall()
            }
        }
    }

    // MARK: - Account Section

    private var accountSection: some View {
        SettingsCard(
            title: "Vellum Platform",
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
                        await authManager.loginWithToast(showToast: showToast, onSuccess: { onSignIn?() })
                    }
                }
            }
        }
    }
}
