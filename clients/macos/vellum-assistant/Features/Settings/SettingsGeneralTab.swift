import SwiftUI
import VellumAssistantShared
import os

private let settingsGeneralLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "SettingsGeneralTab")

/// General settings tab — account/platform login card followed by appearance settings.
@MainActor
struct SettingsGeneralTab: View {
    @ObservedObject var store: SettingsStore
    var connectionManager: GatewayConnectionManager?
    var authManager: AuthManager
    var onClose: () -> Void
    var showToast: (String, ToastInfo.Style) -> Void
    var onSignIn: (() -> Void)?

    @State private var showingDeleteAccountConfirm: Bool = false
    @State private var showingRetireConfirmation: Bool = false
    @State private var isRetiring: Bool = false

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
    @State private var assistantSwitcherItems: [AssistantPickerItem] = []
    @State private var platformAssistantsById: [String: PlatformAssistant] = [:]
    @State private var isLoadingAssistantSwitcher = false
    @State private var switchingAssistantId: String?
    @State private var assistantSwitcherError: String?
    @State private var dockerOperationTimedOut = false
    @State private var dockerOperationTimeoutTask: Task<Void, Never>?
    @State private var healthzLoaded = false
    @State private var isRefreshingHealthz = false
    @State private var systemResourcesDeepLinkRequested = false
    @State private var subscription: SubscriptionResponse? = nil


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
                    updateManager: updateManager,
                    assistantSwitcherItems: assistantSwitcherItems,
                    selectedAssistantId: selectedAssistantId.isEmpty ? nil : selectedAssistantId,
                    switchingAssistantId: switchingAssistantId,
                    isAssistantSwitcherLoading: isLoadingAssistantSwitcher,
                    assistantSwitcherError: assistantSwitcherError,
                    onSwitchAssistant: { assistantId in
                        Task { await switchAssistantFromVersionCard(assistantId: assistantId) }
                    },
                    onRefreshAssistants: {
                        Task { await refreshAssistantSwitcherItems() }
                    }
                )
            }
            if shouldShowSystemResourcesSection {
                systemResourcesSection
            }
            if topology == .managed, let assistant = currentAssistant {
                ProComputeUpgradeSection(
                    assistantId: assistant.assistantId,
                    subscription: subscription,
                    onUpgradeComplete: {
                        Task { await fetchHealthz() }
                    }
                )
            }
            if MacOSClientFeatureFlagManager.shared.isEnabled("teleport"),
               let assistant = currentAssistant,
               !assistant.isRemote || assistant.isDocker || assistant.isManaged {
                TeleportSection(assistant: assistant, onClose: onClose)
            }
            SettingsAppearanceTab(store: store)
            OpenSourceSettingsCard()
            if !lockfileAssistants.isEmpty {
                retireAssistantSection
            }
            if Self.shouldShowDangerZone(isAuthenticated: authManager.currentUser != nil) {
                dangerZoneSection
            }
        }
        .onAppear {
            Task {
                await authManager.checkSession()
                await refreshAssistantSwitcherItems()
            }
            selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""
            sparkleUpdateAvailable = AppDelegate.shared?.updateManager.isUpdateAvailable ?? false
            sparkleUpdateVersion = AppDelegate.shared?.updateManager.availableUpdateVersion
            // Seed update state from connectionManager — .onChange only fires on
            // subsequent changes, not the initial value.
            isServiceGroupUpdateInProgress = connectionManager?.isUpdateInProgress ?? false
            updateStatusMessage = connectionManager?.updateStatusMessage
            Task {
                // Load lockfile on a background thread — the underlying
                // Data(contentsOf:) file I/O can block the main thread.
                await refreshLockfileAssistants()
                await fetchHealthz()
                await refreshAssistantSwitcherItems()
            }
            Task { await refreshSubscription() }
            recordSystemResourcesDeepLinkIfNeeded(store.pendingSettingsGeneralSection)
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            Task {
                await refreshAssistantSwitcherItems()
                if !isAuthenticated {
                    subscription = nil
                } else {
                    await refreshSubscription()
                }
            }
        }
        .onChange(of: store.pendingSettingsGeneralSection) { _, section in
            recordSystemResourcesDeepLinkIfNeeded(section)
        }
        .onChange(of: connectionManager?.isUpdateInProgress) { _, inProgress in
            isServiceGroupUpdateInProgress = inProgress ?? false
        }
        .onChange(of: connectionManager?.updateStatusMessage) { _, message in
            updateStatusMessage = message
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            sparkleUpdateAvailable = AppDelegate.shared?.updateManager.isUpdateAvailable ?? false
            sparkleUpdateVersion = AppDelegate.shared?.updateManager.availableUpdateVersion
        }
        .task {
            for await _ in NotificationCenter.default.notifications(named: LockfileAssistant.activeAssistantDidChange) {
                await refreshLockfileAssistants()
                await fetchHealthz()
                await refreshAssistantSwitcherItems()
                await refreshSubscription()
            }
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
        .sheet(isPresented: $showingDeleteAccountConfirm) {
            DeleteAccountConfirmView(
                onDeleted: { _ in
                    showingDeleteAccountConfirm = false
                    // The server has destroyed the user; tear down the local
                    // session via the standard logout path. Platform-assistant
                    // state cached in this client may briefly throw stale
                    // references — acceptable since the user can re-pair from
                    // the bare-metal/local sign-in screen.
                    AppDelegate.shared?.performLogout()
                },
                onCancel: {
                    showingDeleteAccountConfirm = false
                }
            )
        }
        .alert("Retire Assistant", isPresented: $showingRetireConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Retire", role: .destructive) {
                isRetiring = true
                Task {
                    let completed = await AppDelegate.shared?.performRetireAsync() ?? false
                    if !completed {
                        isRetiring = false
                    }
                }
            }
        } message: {
            if lockfileAssistants.count > 1 {
                Text("This will stop the current assistant and switch to another. The retired assistant's lockfile entry will be removed.")
            } else {
                Text("This will stop the assistant, remove local data, and return to initial setup. This action cannot be undone.")
            }
        }
        .sheet(isPresented: $isRetiring) {
            VStack(spacing: VSpacing.lg) {
                ProgressView()
                    .controlSize(.regular)
                    .progressViewStyle(.circular)
                Text("Retiring assistant...")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("Stopping the assistant and removing local data.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(VSpacing.xxl)
            .frame(minWidth: 260)
            .interactiveDismissDisabled()
        }
    }

    // MARK: - Software Update

    private func refreshLockfileAssistants() async {
        let assistants = await Task.detached { LockfileAssistant.loadAll() }.value
        lockfileAssistants = assistants
        selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""

        if assistantSwitcherItems.isEmpty {
            let landscape = ReturningUserRouter.AssistantLandscape(
                lockfileAssistants: assistants,
                platformAssistants: [],
                platformWasConsulted: false
            )
            assistantSwitcherItems = AssistantPickerItem.from(landscape: landscape)
        }
    }

    private func refreshAssistantSwitcherItems() async {
        isLoadingAssistantSwitcher = true
        assistantSwitcherError = nil
        defer { isLoadingAssistantSwitcher = false }

        do {
            let landscape = try await ReturningUserRouter().fetchLandscape()
            lockfileAssistants = landscape.lockfileAssistants
            selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""
            platformAssistantsById = Dictionary(
                landscape.platformAssistants.map { ($0.id, $0) },
                uniquingKeysWith: { first, _ in first }
            )
            assistantSwitcherItems = AssistantPickerItem.from(landscape: landscape)
        } catch is CancellationError {
            return
        } catch {
            settingsGeneralLog.warning("Failed to refresh assistant switcher: \(error.localizedDescription, privacy: .public)")
            assistantSwitcherError = "Could not load assistants."
        }
    }

    private func refreshSubscription() async {
        if let sub = try? await BillingService.shared.getSubscription() {
            subscription = sub
        }
    }

    private func switchAssistantFromVersionCard(assistantId: String) async {
        guard switchingAssistantId == nil else { return }
        guard assistantId != selectedAssistantId else { return }

        switchingAssistantId = assistantId
        assistantSwitcherError = nil
        defer {
            if switchingAssistantId == assistantId {
                switchingAssistantId = nil
            }
        }

        guard let target = AssistantPickerSelectionResolver.resolveLockfileAssistant(
            assistantId: assistantId,
            platformAssistants: platformAssistantsById
        ) else {
            assistantSwitcherError = "Could not switch assistants."
            return
        }

        if target.isManaged,
           let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            do {
                try await AuthService.shared.activateAssistant(
                    id: target.assistantId,
                    organizationId: orgId
                )
            } catch {
                settingsGeneralLog.warning("Failed to activate assistant on platform: \(error.localizedDescription, privacy: .public)")
            }
        }

        selectedAssistantId = target.assistantId
        if !lockfileAssistants.contains(where: { $0.assistantId == target.assistantId }) {
            lockfileAssistants.append(target)
        }

        AppDelegate.shared?.performSwitchAssistant(
            to: target,
            managedAuthenticationAlreadyVerified: target.isManaged && authManager.isAuthenticated
        )
    }

    private func fetchHealthz() async {
        guard !selectedAssistantId.isEmpty else { return }
        isRefreshingHealthz = true
        defer { isRefreshingHealthz = false }
        do {
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            healthz = decoded ?? DaemonHealthz()
        } catch {
            healthz = DaemonHealthz()
        }
        healthzLoaded = true
        systemResourcesDeepLinkRequested = false
    }

    // MARK: - System Resources

    private var shouldShowSystemResourcesSection: Bool {
        Self.shouldShowSystemResourcesSection(
            topology: topology,
            healthz: healthz,
            pendingSection: store.pendingSettingsGeneralSection,
            deepLinkRequestPending: systemResourcesDeepLinkRequested && !healthzLoaded
        )
    }

    nonisolated static func shouldShowSystemResourcesSection(
        topology: AssistantTopology,
        healthz: DaemonHealthz?,
        pendingSection: SettingsGeneralSection?,
        deepLinkRequestPending: Bool = false
    ) -> Bool {
        topology == .managed || hasResourceMetrics(healthz) || pendingSection == .systemResources || deepLinkRequestPending
    }

    nonisolated static func hasResourceMetrics(_ healthz: DaemonHealthz?) -> Bool {
        guard let healthz else { return false }
        return healthz.disk != nil || healthz.memory != nil || healthz.cpu != nil
    }

    private func recordSystemResourcesDeepLinkIfNeeded(_ section: SettingsGeneralSection?) {
        if section == .systemResources {
            systemResourcesDeepLinkRequested = true
        }
    }

    /// Resource usage card shown for any assistant that reports metrics. Mirrors
    /// the disk/memory/CPU rows from the Developer tab so users can review disk
    /// pressure without enabling dev mode.
    private var systemResourcesSection: some View {
        SettingsCard(
            title: "Storage & Resources",
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
                        caption: "\(Self.formatMb(disk.usedMb)) used of \(Self.formatMb(disk.totalMb))",
                        accessibilityLabel: "Disk usage"
                    )
                }

                if let memory = healthz.memory {
                    resourceBarRow(
                        label: "Memory:",
                        ratio: memory.currentMb / max(memory.maxMb, 1),
                        caption: "\(Self.formatMb(memory.currentMb)) / \(Self.formatMb(memory.maxMb))",
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
        .id(SettingsGeneralSection.systemResources)
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

    nonisolated static func formatMb(_ mb: Double) -> String {
        if mb >= 1024 {
            return String(format: "%.1f GB", mb / 1024.0)
        }
        return String(format: "%.0f MB", mb)
    }

    // MARK: - Retire Assistant

    private var retireAssistantSection: some View {
        SettingsCard(
            title: "Retire Assistant",
            subtitle: lockfileAssistants.count > 1
                ? "Stops the current assistant and switches to another."
                : "Stops the assistant, removes local data, and returns to initial setup."
        ) {
            VButton(label: "Retire", style: .danger) {
                showingRetireConfirmation = true
            }
        }
    }

    // MARK: - Danger Zone

    /// Whether to render the Danger Zone (account deletion) section. Gated on
    /// both the client-side `account-deletion` feature flag (mirroring the
    /// server-side LaunchDarkly flag in `vellum-assistant-platform`) and a
    /// signed-in session — without a `currentUser`, the POST would fail with
    /// notAuthenticated, so we don't expose the destructive button.
    nonisolated static func shouldShowDangerZone(
        flagManager: MacOSClientFeatureFlagManager = .shared,
        isAuthenticated: Bool
    ) -> Bool {
        flagManager.isEnabled("account-deletion") && isAuthenticated
    }

    private var dangerZoneSection: some View {
        SettingsCard(
            title: "Danger Zone",
            subtitle: "Permanently delete your Vellum account."
        ) {
            VButton(label: "Delete account", style: .danger) {
                showingDeleteAccountConfirm = true
            }
            .accessibilityLabel("Delete account")
        }
    }

    // MARK: - Account Section

    private var accountSection: some View {
        SettingsCard(
            title: "Vellum Platform",
            subtitle: accountSectionSubtitle
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
            } else if authManager.isValidationFailed {
                // Token on disk couldn't be validated (transient network /
                // server failure). Do NOT offer a login button — the user is
                // still logged in; the next successful validation will
                // recover. See AuthState.validationFailed documentation.
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Reconnecting to Vellum...")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    VButton(label: "Retry", style: .outlined) {
                        Task { await authManager.checkSession() }
                    }
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

    private var accountSectionSubtitle: String {
        if let email = authManager.currentUser?.email { return email }
        if let display = authManager.currentUser?.display { return display }
        if authManager.isLoading { return "Checking session..." }
        if authManager.isValidationFailed { return "Reconnecting to Vellum..." }
        return "Log in to your account"
    }
}
