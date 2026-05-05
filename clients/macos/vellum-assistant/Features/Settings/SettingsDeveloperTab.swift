import Foundation
import SwiftUI
@preconcurrency import Sentry
import VellumAssistantShared
import os

/// Developer settings tab — consolidates all internal tooling: assistant info,
/// switching/wake controls, gateway settings, hatch, retire, advanced dev tools
/// (permission simulator, feature flags, env vars), and Sentry testing.
@MainActor
struct SettingsDeveloperTab: View {
    @ObservedObject var store: SettingsStore
    private var devModeManager: DevModeManager { DevModeManager.shared }
    var connectionManager: GatewayConnectionManager?
    var featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()
    var authManager: AuthManager
    var onClose: () -> Void

    // -- Assistant Info state --
    @State private var showingRetireConfirmation: Bool = false
    @State private var isRetiring: Bool = false
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""
    @State private var identity: IdentityInfo?
    @State private var devModeTapCount: Int = 0
    @State private var devModeMessage: String?
    @State private var showingHatchConfirmation: Bool = false
    @State private var displayNames: [String: String] = [:]
    @State private var awakeStates: [String: Bool] = [:]
    @State private var transitioningStates: Set<String> = []
    @State private var platformUuid: String?
    @State private var machineId: String?
    @State private var machineIdTask: Task<Void, Never>?

    // -- Advanced dev state --
    @State private var macOSFlagStates: [MacOSFeatureFlagState] = []
    @State private var assistantFlags: [AssistantFeatureFlag] = []
    @State private var assistantFlagsError: String?
    @State private var isLoadingAssistantFlags = false
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    @State private var testerModel: ToolPermissionTesterModel?

    // -- Healthz / restart state --
    @State private var healthz: DaemonHealthz?
    @State private var showingRestartConfirmation: Bool = false
    @State private var isRestarting: Bool = false

    // -- Revoke API key state --
    @State private var showingRevokeApiKeyConfirmation: Bool = false
    @State private var isRevokingApiKey: Bool = false
    @State private var revokeApiKeyStatus: String?
    @State private var revokeApiKeyDismissTask: Task<Void, Never>?

    // -- Sentry testing state --
    @State private var lastSentryStatus: String?
    @State private var sentryDismissTask: Task<Void, Never>?
    @State private var isSentryEnabled: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Platform URL (inferred from environment)
            platformUrlSection
            // Assistant Info
            assistantInfoSection
            // Switch Assistant
            switchAssistantSection
            // Managed/remote-only sections
            if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
               assistant.isManaged || assistant.isRemote {
                restartAssistantSection
                if assistant.isManaged {
                    sshTerminalSection
                }
            }
            // Transfer (local ↔ managed)
            if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
               !assistant.isRemote || assistant.isManaged {
                AssistantTransferSection(
                    assistant: assistant,
                    onClose: onClose
                )
            }
            // Gateway Settings
            GatewaySettingsCard(
                store: store,
                connectionManager: connectionManager,
                isManaged: lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId })?.isManaged ?? false
            )
            // Hatch New Assistant
            hatchNewAssistantSection
            // Retire Assistant
            retireAssistantSection

            // Revoke Assistant API Key (dev mode only)
            if devModeManager.isDevMode {
                revokeAssistantApiKeySection
            }

            // Permission Simulator
            if let model = testerModel {
                ToolPermissionTesterView(model: model)
            }

            // Feature Flags
            FeatureFlagsCard(
                assistantFlags: $assistantFlags,
                macOSFlagStates: $macOSFlagStates,
                assistantFlagsError: assistantFlagsError,
                isLoadingAssistantFlags: isLoadingAssistantFlags,
                featureFlagClient: featureFlagClient
            )
            // Environment Variables
            environmentVariablesSection
            // Hello World VM
            DeveloperHelloWorldVMSection()
            // Sentry Testing
            sentryTestingSection
        }
        .onAppear {
            // Assistant info setup
            selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""
            Task {
                let assistants = await Task.detached { LockfileAssistant.loadAll() }.value
                lockfileAssistants = assistants
                refreshDisplayNames()
                resolvePlatformUuid()
                await refreshAwakeStates()
                await fetchHealthz()
            }
            Task { identity = await IdentityInfo.loadAsync() }

            // Advanced dev setup
            macOSFlagStates = MacOSClientFeatureFlagManager.shared.allFlagStates()
            if testerModel == nil, let dc = connectionManager {
                testerModel = ToolPermissionTesterModel(connectionManager: dc)
            }
            Task { await loadAssistantFlags() }

            // Sentry setup
            isSentryEnabled = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
                ?? true
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
        .alert("Restart Assistant", isPresented: $showingRestartConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Restart") {
                isRestarting = true
                Task {
                    await performRestart()
                    isRestarting = false
                }
            }
        } message: {
            Text("Are you sure you want to restart the assistant? It will be briefly unavailable.")
        }
        .alert("Revoke Assistant API Key", isPresented: $showingRevokeApiKeyConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Revoke", role: .destructive) {
                Task { await revokeAssistantApiKey() }
            }
        } message: {
            Text("This will disable managed inference. Services set to \"managed\" mode will stop working until you log in again or switch them to use your own API keys.")
        }
        .sheet(isPresented: $isRestarting) {
            VStack(spacing: VSpacing.lg) {
                ProgressView()
                    .controlSize(.regular)
                    .progressViewStyle(.circular)
                Text("Restarting assistant...")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("The assistant will be briefly unavailable.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(VSpacing.xxl)
            .frame(minWidth: 260)
            .interactiveDismissDisabled()
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
        .sheet(isPresented: $showingEnvVars) {
            SettingsPanelEnvVarsSheet(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        .onDisappear {
            sentryDismissTask?.cancel()
            revokeApiKeyDismissTask?.cancel()
        }
    }

    // MARK: - Platform URL

    private var platformUrlSection: some View {
        SettingsCard(title: "Platform URL") {
            Text(VellumEnvironment.resolvedPlatformURL)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .textSelection(.enabled)
        }
    }

    // MARK: - Assistant Info

    private var assistantInfoSection: some View {
        SettingsCard(title: "Assistant Info") {
            if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) {
                infoRow(label: "Assistant ID", value: assistant.assistantId, mono: true)
                    .onTapGesture {
                        devModeTapCount += 1
                        if devModeTapCount >= 7 {
                            devModeManager.toggle()
                            devModeTapCount = 0
                            devModeMessage = devModeManager.isDevMode
                                ? "Dev mode enabled"
                                : "Dev mode disabled"
                            Task {
                                try? await Task.sleep(nanoseconds: 2_000_000_000)
                                devModeMessage = nil
                            }
                        }
                    }

                if let machineId, !machineId.isEmpty {
                    infoRow(label: "Machine ID", value: machineId, mono: true)
                }

                let home = assistant.home
                homeRow(home: home)
            }

            if let message = devModeMessage {
                Text(message)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.primaryBase)
                    .transition(.opacity)
            }

            if let connectionManager {
                DeveloperStatusRows(connectionManager: connectionManager)
            }

            healthzInfoRows
        }
    }

    // MARK: - Healthz Info

    private var desktopAppVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// The assistant version reported by the health endpoint, if available.
    private var effectiveVersion: String? {
        if let version = healthz?.version, !version.isEmpty {
            return version
        }
        return nil
    }

    /// Whether the assistant and client versions are incompatible (different major.minor).
    private var isVersionIncompatible: Bool {
        guard let assistantVersion = healthz?.version, !assistantVersion.isEmpty,
              let appVersion = desktopAppVersion, !appVersion.isEmpty else {
            return false
        }
        return !VersionCompat.isCompatible(
            clientVersion: appVersion,
            serviceGroupVersion: assistantVersion
        )
    }

    /// Whether the assistant version is strictly behind the client version.
    /// Used to determine if an upgrade action should be offered.
    private var assistantVersionBehind: Bool {
        guard let assistantVersion = healthz?.version, !assistantVersion.isEmpty,
              let appVersion = desktopAppVersion, !appVersion.isEmpty,
              let assistantParsed = VersionCompat.parse(assistantVersion),
              let appParsed = VersionCompat.parse(appVersion) else {
            return false
        }
        return assistantParsed < appParsed
    }

    @ViewBuilder
    private var healthzInfoRows: some View {
        // Always show a version row
        HStack(alignment: .top) {
            Text("Version")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            if let version = effectiveVersion {
                Text(version)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(isVersionIncompatible ? VColor.systemNegativeStrong : VColor.contentDefault)
                    .textSelection(.enabled)
            } else {
                Text("Not available")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            }

            Spacer()
        }

        if isVersionIncompatible, let appVersion = desktopAppVersion {
            HStack(spacing: VSpacing.xs) {
                Text(assistantVersionBehind ? "Desktop is on" : "Incompatible with desktop")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                Text(appVersion)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.primaryBase)
            }
        }

        if let healthz {
            if let disk = healthz.disk {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(alignment: .center) {
                        Text("Disk")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .frame(width: 100, alignment: .leading)
                        Text("\(formatMb(disk.usedMb)) used of \(formatMb(disk.totalMb))")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                        Spacer()
                    }
                    ProgressView(value: Double(disk.usedMb), total: Double(max(disk.totalMb, 1)))
                        .progressViewStyle(.linear)
                        .tint(Double(disk.usedMb) / Double(max(disk.totalMb, 1)) > 0.9 ? VColor.systemNegativeStrong : VColor.primaryBase)
                }
            }

            if let memory = healthz.memory {
                infoRow(label: "Memory", value: "\(formatMb(memory.currentMb)) / \(formatMb(memory.maxMb))")
            }

            if let cpu = healthz.cpu {
                infoRow(label: "CPU", value: String(format: "%.1f%%", cpu.currentPercent))
            }
        } else {
            HStack(spacing: VSpacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading health metrics...")
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

    private func fetchHealthz() async {
        do {
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            healthz = decoded ?? DaemonHealthz()
        } catch {
            healthz = DaemonHealthz()
        }
    }

    private func infoRow(label: String, value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            Text(value)
                .font(mono ? VFont.bodyMediumDefault : VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .textSelection(.enabled)

            Spacer()
        }
    }

    @ViewBuilder
    private func homeRow(home: AssistantHome) -> some View {
        HStack(alignment: .top) {
            Text("Home")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(home.displayLabel)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                ForEach(Array(home.displayDetails.enumerated()), id: \.offset) { _, detail in
                    HStack(spacing: VSpacing.xs) {
                        Text(detail.label + ":")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Text(detail.value)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .textSelection(.enabled)
                    }
                }

                if let uuid = platformUuid {
                    HStack(spacing: VSpacing.xs) {
                        Text("Platform ID:")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Text(uuid)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .textSelection(.enabled)
                    }
                }
            }

            Spacer()
        }
    }

    private func resolvePlatformUuid() {
        guard let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) else {
            platformUuid = nil
            machineIdTask?.cancel()
            machineId = nil
            return
        }
        let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
        let userId = authManager.currentUser?.id
        platformUuid = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: assistant.assistantId,
            isManaged: assistant.isManaged,
            organizationId: orgId,
            userId: userId,
            credentialStorage: FileCredentialStorage()
        )
        fetchMachineId(orgId: orgId)
    }

    private func fetchMachineId(orgId: String?) {
        machineIdTask?.cancel()
        machineId = nil
        guard let orgId, let platformId = platformUuid else { return }
        machineIdTask = Task {
            do {
                let result = try await AuthService.shared.getAssistant(id: platformId, organizationId: orgId)
                try Task.checkCancellation()
                if case .found(let assistant) = result {
                    machineId = assistant.machine_id
                }
            } catch {
                // Cancelled, network failure, decode error — best-effort dev info.
            }
        }
    }

    // MARK: - Switch Assistant

    @ViewBuilder
    private var switchAssistantSection: some View {
        if lockfileAssistants.count > 1 {
            SettingsCard(title: "Assistants") {
                ForEach(lockfileAssistants, id: \.assistantId) { assistant in
                    HStack(spacing: VSpacing.sm) {
                        if transitioningStates.contains(assistant.assistantId) {
                            ProgressView()
                                .controlSize(.small)
                        }
                        VToggle(isOn: Binding(
                            get: { awakeStates[assistant.assistantId] ?? false },
                            set: { isOn in
                                toggleAwakeState(assistant: assistant, awake: isOn)
                            }
                        ))
                        .disabled(toggleDisabled(for: assistant))
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            Text(displayLabel(for: assistant))
                                .font(VFont.bodyMediumDefault)
                                .foregroundStyle(VColor.contentDefault)
                            Text(assistantSubtitle(for: assistant))
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                    }
                    .padding(.vertical, VSpacing.xs)
                }

                SettingsDivider()

                HStack {
                    Text("Active")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    VDropdown(
                        placeholder: "",
                        selection: $selectedAssistantId,
                        options: awakeAssistants.map { (label: displayLabel(for: $0), value: $0.assistantId) },
                        maxWidth: 200
                    )
                }
            }
            .onChange(of: selectedAssistantId) { oldValue, newValue in
                resolvePlatformUuid()
                let currentId = LockfileAssistant.loadActiveAssistantId() ?? ""
                guard newValue != currentId, newValue != oldValue else { return }
                guard let assistant = lockfileAssistants.first(where: { $0.assistantId == newValue }) else { return }
                guard awakeStates[assistant.assistantId] == true else {
                    selectedAssistantId = currentId
                    return
                }
                switchToAssistant(assistant)
            }
        }
    }

    private var awakeAssistants: [LockfileAssistant] {
        lockfileAssistants.filter { awakeStates[$0.assistantId] ?? false }
    }

    private func toggleDisabled(for assistant: LockfileAssistant) -> Bool {
        if assistant.isRemote { return true }
        if transitioningStates.contains(assistant.assistantId) { return true }
        return false
    }

    private func refreshDisplayNames() {
        for assistant in lockfileAssistants {
            if let name = assistant.loadDisplayName() {
                displayNames[assistant.assistantId] = name
            } else {
                let cachedName = IdentityInfo.cached(for: assistant.assistantId)?.name
                if let resolved = AssistantDisplayName.firstUserFacing(from: [cachedName]),
                   resolved != AssistantDisplayName.placeholder {
                    displayNames[assistant.assistantId] = resolved
                }
            }
        }
    }

    private func displayLabel(for assistant: LockfileAssistant) -> String {
        displayNames[assistant.assistantId] ?? assistant.assistantId
    }

    private func assistantSubtitle(for assistant: LockfileAssistant) -> String {
        var parts: [String] = []
        if displayNames[assistant.assistantId] != nil {
            parts.append(assistant.assistantId)
        }
        parts.append(assistant.home.displayLabel)
        if assistant.isManaged, let runtimeUrl = assistant.runtimeUrl, !runtimeUrl.isEmpty {
            parts.append(runtimeUrl)
        }
        return parts.joined(separator: " · ")
    }

    private func refreshAwakeStates() async {
        for assistant in lockfileAssistants {
            if assistant.isRemote {
                awakeStates[assistant.assistantId] = true
            } else {
                awakeStates[assistant.assistantId] = await HealthCheckClient.isReachable(for: assistant)
            }
        }
    }

    private func toggleAwakeState(assistant: LockfileAssistant, awake: Bool) {
        guard !assistant.isRemote else { return }
        guard let cli = AppDelegate.shared?.vellumCli else { return }

        transitioningStates.insert(assistant.assistantId)
        Task {
            do {
                if awake {
                    try await cli.wake(name: assistant.assistantId)
                } else {
                    try await cli.sleep(name: assistant.assistantId)
                }
                awakeStates[assistant.assistantId] = awake
                if !awake && assistant.assistantId == selectedAssistantId {
                    if let next = lockfileAssistants.first(where: {
                        $0.assistantId != assistant.assistantId && (awakeStates[$0.assistantId] ?? false)
                    }) {
                        switchToAssistant(next)
                        selectedAssistantId = next.assistantId
                    }
                }
            } catch {
                awakeStates[assistant.assistantId] = await HealthCheckClient.isReachable(for: assistant)
            }
            transitioningStates.remove(assistant.assistantId)
        }
    }

    private func switchToAssistant(_ assistant: LockfileAssistant) {
        AppDelegate.shared?.performSwitchAssistant(to: assistant)
        onClose()
    }

    // MARK: - Restart Assistant

    private var restartAssistantSection: some View {
        SettingsCard(
            title: "Restart Assistant",
            subtitle: "The assistant will be briefly unavailable during restart."
        ) {
            VButton(label: "Restart", style: .outlined) {
                showingRestartConfirmation = true
            }
        }
    }

    private func performRestart() async {
        guard let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) else { return }

        if assistant.isManaged || assistant.isRemote {
            await performManagedRestart()
        } else {
            await performLocalRestart()
        }

        try? await Task.sleep(nanoseconds: 2_000_000_000)
        await fetchHealthz()
    }

    private func performManagedRestart() async {
        _ = try? await GatewayHTTPClient.post(path: "restart")
    }

    private func performLocalRestart() async {
        do {
            try await AppDelegate.shared?.vellumCli.hatch(
                name: selectedAssistantId
            )
        } catch {}
    }

    // MARK: - SSH Terminal

    /// `true` while either a maintenance-enter or maintenance-exit request is in flight.
    private var maintenanceTransitionInFlight: Bool {
        store.recoveryModeEntering || store.recoveryModeExiting
    }

    private var sshTerminalSection: some View {
        SettingsCard(
            title: "SSH Terminal",
            subtitle: "Recovery mode pauses the normal assistant pod and routes terminal sessions into the mounted debug pod, giving you direct access to the assistant's workspace PVC."
        ) {
            // Recovery mode status row
            recoveryModeStatusRow

            SettingsDivider()

            // Recovery mode action buttons
            HStack(spacing: VSpacing.sm) {
                if store.managedAssistantRecoveryMode?.enabled == true {
                    VButton(
                        label: "Resume Assistant",
                        style: .outlined,
                        isDisabled: maintenanceTransitionInFlight
                    ) {
                        store.exitManagedAssistantRecoveryMode()
                    }
                    .accessibilityLabel("Resume Assistant")
                } else {
                    VButton(
                        label: "Enter Recovery Mode",
                        style: .outlined,
                        isDisabled: maintenanceTransitionInFlight
                    ) {
                        store.enterManagedAssistantRecoveryMode()
                    }
                    .accessibilityLabel("Enter Recovery Mode")
                }

                VButton(label: "Open Terminal", style: .primary) {
                    openTerminalWindow()
                }
                .accessibilityLabel("Open Terminal")
            }

            // Show inline error messages if a maintenance operation fails.
            if let enterError = store.recoveryModeEnterError {
                Text(enterError)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
            if let exitError = store.recoveryModeExitError {
                Text(exitError)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
    }

    @ViewBuilder
    private var recoveryModeStatusRow: some View {
        if store.recoveryModeRefreshing {
            HStack(spacing: VSpacing.sm) {
                ProgressView()
                    .controlSize(.mini)
                    .progressViewStyle(.circular)
                Text("Loading recovery status…")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        } else if let maintenance = store.managedAssistantRecoveryMode {
            if maintenance.enabled {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.xs) {
                        Circle()
                            .fill(VColor.systemMidStrong)
                            .frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                        Text("Recovery mode active")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                            .accessibilityValue("Recovery mode active")
                    }
                    if let podName = maintenance.debug_pod_name, !podName.isEmpty {
                        Text("Debug pod: \(podName)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .textSelection(.enabled)
                    }
                }
            } else {
                HStack(spacing: VSpacing.xs) {
                    Circle()
                        .fill(VColor.systemPositiveStrong)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text("Assistant running normally")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .accessibilityValue("Assistant running normally")
                }
            }
        } else {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Recovery status unavailable")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                if let refreshError = store.recoveryModeRefreshError {
                    Text(refreshError)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
            }
        }
    }

    private static let terminalWindow = SSHTerminalWindow()

    private func openTerminalWindow() {
        guard let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
              assistant.isManaged else { return }

        Self.terminalWindow.open(assistant: assistant)
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

    // MARK: - Revoke Assistant API Key

    private var revokeAssistantApiKeySection: some View {
        SettingsCard(
            title: "Revoke Assistant API Key",
            subtitle: "Revokes the API key used by the assistant to interact with the Vellum platform."
        ) {
            VButton(label: "Revoke", style: .danger, isDisabled: isRevokingApiKey) {
                showingRevokeApiKeyConfirmation = true
            }

            if let status = revokeApiKeyStatus {
                Text(status)
                    .font(VFont.labelDefault)
                    .foregroundStyle(status.starts(with: "Failed") ? VColor.systemNegativeStrong : VColor.systemPositiveStrong)
                    .transition(.opacity)
            }
        }
    }

    private func revokeAssistantApiKey() async {
        isRevokingApiKey = true
        defer { isRevokingApiKey = false }

        // Capture assistant ID before the await so local credential cleanup
        // targets the same assistant the remote DELETE was issued against,
        // even if the user switches assistants while the request is in flight.
        let targetAssistantId = selectedAssistantId

        let body: [String: String] = ["type": "credential", "name": "vellum:assistant_api_key"]
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "secrets", json: body, timeout: 10
            )
            if response.isSuccess || response.statusCode == 404 {
                // Clear the locally-cached credential so the key is not
                // re-injected on the next daemon restart or bootstrap.
                LocalAssistantBootstrapService.clearBootstrapCredential(
                    runtimeAssistantId: targetAssistantId,
                    credentialStorage: FileCredentialStorage()
                )

                showRevokeStatus("Assistant API key revoked", isError: false)
            } else {
                showRevokeStatus("Failed to revoke (HTTP \(response.statusCode))", isError: true)
            }
        } catch {
            showRevokeStatus("Failed to revoke: \(error.localizedDescription)", isError: true)
        }
    }

    private func showRevokeStatus(_ message: String, isError: Bool) {
        revokeApiKeyDismissTask?.cancel()
        withAnimation { revokeApiKeyStatus = message }
        revokeApiKeyDismissTask = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation {
                if revokeApiKeyStatus == message { revokeApiKeyStatus = nil }
            }
        }
    }

    // MARK: - Hatch New Assistant

    private var hatchNewAssistantSection: some View {
        SettingsCard(title: "Hatch New Assistant", subtitle: "Starts the initial setup flow to create a new assistant.") {
            VButton(label: "Hatch", style: .primary) {
                showingHatchConfirmation = true
            }
            .alert("Hatch New Assistant", isPresented: $showingHatchConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Continue") {
                    AppDelegate.shared?.hatchNewAssistant()
                    onClose()
                }
            } message: {
                Text("This will create a brand new assistant. Your existing assistant(s) will continue to exist and you can switch back to using them.")
            }
        }
    }

    // MARK: - Feature Flags

    private func loadAssistantFlags() async {
        guard connectionManager != nil else { return }
        isLoadingAssistantFlags = true
        assistantFlagsError = nil
        do {
            let flags = try await featureFlagClient.getFeatureFlags()
            assistantFlags = flags
            // Cache the gateway state for persistence across restarts
            let cacheValues = Dictionary(uniqueKeysWithValues: flags.map { ($0.key, $0.enabled) })
            AssistantFeatureFlagResolver.writeCachedFlags(cacheValues)
        } catch {
            // Fall back to the bundled registry + cached gateway flags
            if let registry = loadFeatureFlagRegistry() {
                let resolved = AssistantFeatureFlagResolver.resolvedFlags(registry: registry)
                assistantFlags = registry.assistantScopeFlags().map { def in
                    AssistantFeatureFlag(
                        key: def.key,
                        enabled: resolved[def.key] ?? def.defaultEnabled,
                        defaultEnabled: def.defaultEnabled,
                        description: def.description,
                        label: def.label
                    )
                }
            } else {
                assistantFlagsError = error.localizedDescription
            }
        }
        isLoadingAssistantFlags = false
    }

    // MARK: - Environment Variables

    @ViewBuilder
    private var environmentVariablesSection: some View {
        if connectionManager != nil {
            SettingsCard(title: "Environment Variables", subtitle: "View env vars for both the app and assistant processes") {
                VButton(label: "View", style: .outlined) {
                        appEnvVars = ProcessInfo.processInfo.environment
                            .sorted(by: { $0.key < $1.key })
                            .map { ($0.key, $0.value) }
                        daemonEnvVars = []
                        Task {
                            let response = await DiagnosticsClient().fetchEnvVars()
                            if let response {
                                self.daemonEnvVars = response.vars
                                    .sorted(by: { $0.key < $1.key })
                                    .map { ($0.key, $0.value) }
                            }
                        }
                        showingEnvVars = true
                }
            }
        }
    }

    // MARK: - Sentry Testing

    private var sentryTestingSection: some View {
        SettingsCard(title: "Sentry Testing", subtitle: "Trigger test events to validate that Sentry is receiving reports from this app.") {
            if !isSentryEnabled {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundStyle(VColor.systemNegativeHover)
                    Text("Share Diagnostics is disabled. Non-fatal events will be silently dropped unless you enable \"Share Diagnostics\" in the Privacy tab.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeHover)
                }
            }

            if let status = lastSentryStatus {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundStyle(VColor.systemPositiveStrong)
                    Text(status)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemPositiveStrong)
                }
                .transition(.opacity)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Trigger Fatal Crash", style: .danger) {
                        fatalError("Sentry test crash")
                    }
                    Text("Calls fatalError() — will terminate the app immediately.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Error", style: .outlined) {
                        sendSentryTestEvent(level: .error, label: "error")
                    }
                    Text("Captures a Sentry event with level .error")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Warning", style: .outlined) {
                        sendSentryTestEvent(level: .warning, label: "warning")
                    }
                    Text("Captures a Sentry event with level .warning")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Message", style: .outlined) {
                        sendSentryTestEvent(level: .info, label: "info message")
                    }
                    Text("Captures a Sentry event with level .info")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Test Performance Transaction", style: .outlined) {
                        guard isSentryEnabled else {
                            showSentryStatus("Sentry is disabled — transaction not sent.")
                            return
                        }
                        MetricKitManager.sentrySerialQueue.async {
                            guard SentrySDK.isEnabled else {
                                Task { @MainActor in showSentryStatus("Sentry is disabled — transaction not sent.") }
                                return
                            }
                            let transaction = SentrySDK.startTransaction(
                                name: "settings-debug-test",
                                operation: "test.transaction"
                            )
                            transaction.finish()
                            Task { @MainActor in
                                showSentryStatus("Transaction finished (10% sample rate — may not appear in Sentry).")
                            }
                        }
                    }
                    Text("Starts and finishes a Sentry transaction. Only ~10% are sampled and sent.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
        }
    }

    private func sendSentryTestEvent(level: SentryLevel, label: String) {
        guard isSentryEnabled else {
            showSentryStatus("Sentry is disabled — \(label) not sent.")
            return
        }
        let event = Event(level: level)
        event.message = SentryMessage(formatted: "Sentry test \(label) from Settings debug tab")
        event.tags = ["source": "settings_debug"]
        MetricKitManager.captureSentryEvent(event)
        showSentryStatus("\(label.capitalized) event sent!")
    }

    private func showSentryStatus(_ message: String) {
        sentryDismissTask?.cancel()
        withAnimation { lastSentryStatus = message }
        sentryDismissTask = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation {
                if lastSentryStatus == message { lastSentryStatus = nil }
            }
        }
    }
}

// MARK: - Daemon Status Rows (Developer Tab)

private struct DeveloperStatusRows: View {
    var connectionManager: GatewayConnectionManager

    var body: some View {
        statusRow(
            label: "Assistant",
            isHealthy: connectionManager.isConnected,
            detail: connectionManager.isConnected
                ? "Connected" + (connectionManager.assistantVersion.map { " (v\($0))" } ?? "")
                : "Disconnected"
        )

        if let memoryStatus = connectionManager.latestMemoryStatus {
            statusRow(
                label: "Memory",
                isHealthy: memoryStatus.enabled && !memoryStatus.degraded,
                detail: !memoryStatus.enabled ? "Disabled"
                    : memoryStatus.degraded ? "Degraded\(memoryStatus.reason.map { " — \($0)" } ?? "")"
                    : "Healthy"
            )
        }
    }

    private func statusRow(label: String, isHealthy: Bool, detail: String) -> some View {
        HStack(alignment: .center) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            Circle()
                .fill(isHealthy ? VColor.systemPositiveStrong : VColor.systemNegativeStrong)
                .frame(width: 8, height: 8)

            Text(detail)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)

            Spacer()
        }
    }
}
