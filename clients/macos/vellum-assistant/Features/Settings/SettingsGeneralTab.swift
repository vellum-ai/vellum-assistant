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
    @State private var updateStatusMessage: String?
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""
    @State private var dockerOperationTimedOut = false
    @State private var dockerOperationTimeoutTask: Task<Void, Never>?
    @State private var healthzLoaded = false
    @State private var isRefreshingHealthz = false

    /// Publisher for reactive observation of connectionManager's isUpdateInProgress.
    /// Falls back to a single `false` emission when connectionManager is nil.
    private var updateInProgressPublisher: AnyPublisher<Bool, Never> {
        if let cm = connectionManager {
            return cm.$isUpdateInProgress.eraseToAnyPublisher()
        }
        return Just(false).eraseToAnyPublisher()
    }

    /// Publisher for reactive observation of connectionManager's updateStatusMessage.
    /// Falls back to a single `nil` emission when connectionManager is nil.
    private var updateStatusMessagePublisher: AnyPublisher<String?, Never> {
        if let cm = connectionManager {
            return cm.$updateStatusMessage.eraseToAnyPublisher()
        }
        return Just(nil).eraseToAnyPublisher()
    }

    private var currentAssistant: LockfileAssistant? {
        lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId })
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
            if !lockfileAssistants.isEmpty, let updateManager = AppDelegate.shared?.updateManager {
                AssistantUpgradeSection(
                    currentVersion: connectionManager?.assistantVersion ?? healthz?.version,
                    topology: topology,
                    isDockerOperationInProgress: $isDockerOperationInProgress,
                    dockerOperationLabel: $dockerOperationLabel,
                    sparkleUpdateAvailable: sparkleUpdateAvailable,
                    sparkleUpdateVersion: sparkleUpdateVersion,
                    isServiceGroupUpdateInProgress: isServiceGroupUpdateInProgress,
                    updateStatusMessage: updateStatusMessage,
                    healthzLoaded: healthzLoaded,
                    updateManager: updateManager
                )
            }
            if topology == .managed {
                systemResourcesSection
            }
            if MacOSClientFeatureFlagManager.shared.isEnabled("teleport"),
               let assistant = currentAssistant,
               !assistant.isManaged && (!assistant.isRemote || assistant.isDocker) {
                TeleportSection(assistant: assistant, onClose: onClose)
            }
            if MacOSClientFeatureFlagManager.shared.isEnabled("mobile-pairing") {
                mobilePairingCard
            }
            SettingsAppearanceTab(store: store)
            uninstallSection
        }
        .onAppear {
            Task { await authManager.checkSession() }
            store.refreshApprovedDevices()
            selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""
            sparkleUpdateAvailable = AppDelegate.shared?.updateManager.isUpdateAvailable ?? false
            sparkleUpdateVersion = AppDelegate.shared?.updateManager.availableUpdateVersion
            Task {
                // Load lockfile on a background thread — the underlying
                // Data(contentsOf:) file I/O can block the main thread.
                let assistants = await Task.detached { LockfileAssistant.loadAll() }.value
                lockfileAssistants = assistants
                await fetchHealthz()
            }
        }
        .onReceive(updateInProgressPublisher) { inProgress in
            isServiceGroupUpdateInProgress = inProgress
        }
        .onReceive(updateStatusMessagePublisher) { message in
            updateStatusMessage = message
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
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                    Text(dockerOperationLabel)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    VButton(label: "Dismiss", style: .outlined) {
                        isDockerOperationInProgress = false
                    }
                } else {
                    ProgressView()
                        .controlSize(.regular)
                        .progressViewStyle(.circular)
                    Text(dockerOperationLabel)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                    Text("This may take a minute. The assistant will be briefly unavailable.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            .padding(VSpacing.lg)
            .frame(minWidth: 260)
            .background(VColor.surfaceLift)
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
        isRefreshingHealthz = true
        defer { isRefreshingHealthz = false }
        do {
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            healthz = decoded ?? DaemonHealthz()
        } catch {
            healthz = DaemonHealthz()
        }
        healthzLoaded = true
    }

    // MARK: - System Resources

    /// Resource usage card shown for platform-managed assistants. Mirrors the
    /// disk/memory/CPU rows from the Developer tab so users on the platform can
    /// see their assistant's resource consumption without enabling dev mode.
    private var systemResourcesSection: some View {
        SettingsCard(
            title: "System Resources",
            accessory: {
                if isRefreshingHealthz {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                } else {
                    VButton(
                        label: "Refresh resource metrics",
                        iconOnly: VIcon.refreshCw.rawValue,
                        style: .ghost,
                        size: .compact,
                        tooltip: "Refresh"
                    ) {
                        Task { await fetchHealthz() }
                    }
                }
            }
        ) {
            if let healthz {
                if let disk = healthz.disk {
                    resourceBarRow(
                        label: "Disk Usage:",
                        ratio: disk.usedMb / max(disk.totalMb, 1),
                        caption: "\(formatMb(disk.usedMb)) used of \(formatMb(disk.totalMb))",
                        accessibilityLabel: "Disk usage"
                    )
                }

                if let memory = healthz.memory {
                    resourceBarRow(
                        label: "Memory:",
                        ratio: memory.currentMb / max(memory.maxMb, 1),
                        caption: "\(formatMb(memory.currentMb)) / \(formatMb(memory.maxMb))",
                        accessibilityLabel: "Memory usage"
                    )
                }

                if let cpu = healthz.cpu {
                    resourceBarRow(
                        label: "CPU:",
                        ratio: cpu.currentPercent / 100.0,
                        caption: String(format: "%.1f%%", cpu.currentPercent),
                        accessibilityLabel: "CPU usage"
                    )
                }

                if healthz.disk == nil && healthz.memory == nil && healthz.cpu == nil {
                    Text("Resource metrics are not available for this assistant.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading resource metrics...")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
        }
    }

    /// A resource row with a label on the left, a capsule usage bar, and a gray
    /// caption underneath the bar showing the numeric stats.
    private func resourceBarRow(label: String, ratio: Double, caption: String, accessibilityLabel: String) -> some View {
        let clamped = min(1.0, max(0.0, ratio))
        let isCritical = clamped > 0.9
        let fillColor = isCritical ? VColor.systemNegativeStrong : VColor.systemPositiveStrong
        return HStack(alignment: .top) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(VColor.borderHover)
                        Capsule()
                            .fill(fillColor)
                            .frame(width: clamped * geo.size.width)
                    }
                }
                .frame(height: 8)
                .accessibilityElement()
                .accessibilityLabel(accessibilityLabel)
                .accessibilityValue("\(Int(clamped * 100)) percent")

                Text(caption)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    private func formatMb(_ mb: Double) -> String {
        if mb >= 1024 {
            return String(format: "%.1f GB", mb / 1024.0)
        }
        return String(format: "%.0f MB", mb)
    }

    // MARK: - Mobile Pairing

    private var mobilePairingCard: some View {
        SettingsCard(title: "Mobile (iOS)", subtitle: "Connect your phone to your assistant through the iOS app") {
            if !store.approvedDevices.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Devices")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)

                    ForEach(store.approvedDevices, id: \.hashedDeviceId) { device in
                        HStack(spacing: VSpacing.sm) {
                            VIconView(.smartphone, size: 12)
                                .foregroundStyle(VColor.systemPositiveStrong)
                            Text(device.deviceName)
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentSecondary)
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
                        .foregroundStyle(VColor.systemNegativeHover)
                    Text("Configure a gateway URL to enable pairing")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.systemNegativeHover)
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
            VButton(label: "Uninstall Vellum", style: .danger) {
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
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
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
