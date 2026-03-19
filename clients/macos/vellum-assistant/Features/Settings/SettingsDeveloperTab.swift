import Foundation
import SwiftUI
@preconcurrency import Sentry
import VellumAssistantShared

/// Wraps both `AssistantFeatureFlag` and `MacOSFeatureFlagState` into a single
/// type so the Developer tab can render all flags in one card.
private struct UnifiedFeatureFlag: Identifiable {
    let id: String
    let key: String
    let label: String
    let description: String
    let defaultEnabled: Bool
    let enabled: Bool
    let scope: FeatureFlagScope
}

/// Developer settings tab — consolidates all internal tooling: assistant info,
/// switching/wake controls, gateway settings, hatch, retire, advanced dev tools
/// (permission simulator, feature flags, env vars), and Sentry testing.
@MainActor
struct SettingsDeveloperTab: View {
    @ObservedObject var store: SettingsStore
    @ObservedObject private var devModeManager = DevModeManager.shared
    var daemonClient: DaemonClient?
    var identityClient: IdentityClientProtocol = IdentityClient()
    var featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()
    var authManager: AuthManager
    var onClose: () -> Void

    // -- Assistant Info state --
    @State private var showingRetireConfirmation: Bool = false
    @State private var isRetiring: Bool = false
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""
    @State private var identity: IdentityInfo?
    @State private var remoteIdentity: RemoteIdentityInfo?
    @State private var devModeTapCount: Int = 0
    @State private var devModeMessage: String?
    @State private var showingHatchConfirmation: Bool = false
    @State private var displayNames: [String: String] = [:]
    @State private var awakeStates: [String: Bool] = [:]
    @State private var transitioningStates: Set<String> = []
    @State private var platformUuid: String?

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

    // -- Inline upgrade state --
    @State private var isUpgradingInline = false
    @State private var showingInlineUpgradeConfirmation = false
    @State private var inlineUpgradeError: String?
    @State private var inlineUpgradeSuccess: String?

    // -- Revoke API key state --
    @State private var showingRevokeApiKeyConfirmation: Bool = false
    @State private var isRevokingApiKey: Bool = false
    @State private var revokeApiKeyStatus: String?
    @State private var revokeApiKeyDismissTask: Task<Void, Never>?

    // -- Sentry testing state --
    @State private var lastSentryStatus: String?
    @State private var sentryDismissTask: Task<Void, Never>?
    @State private var isSentryEnabled: Bool = true

    @State private var featureFlagSearchText: String = ""
    @State private var featureFlagScopeFilter: String = "all"

    @State private var platformUrlText: String = ""
    @FocusState private var isPlatformUrlFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Platform URL (dev mode only)
            if devModeManager.isDevMode {
                platformUrlSection
            }
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
            // Backups (all assistant types)
            if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) {
                AssistantBackupsSection(assistant: assistant, store: store)
                    .withRestoreConfirmation
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
                daemonClient: daemonClient,
                isManaged: lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId })?.isManaged ?? false
            )
            // Upgrade (managed/remote only)
            if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
               assistant.isManaged || assistant.isRemote {
                AssistantUpgradeSection(currentVersion: healthz?.version)
            }
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
            featureFlagSection
            // Environment Variables
            environmentVariablesSection
            // Sentry Testing
            sentryTestingSection
        }
        .onAppear {
            // Assistant info setup
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
            Task { await refreshAwakeStates() }
            refreshDisplayNames()
            identity = IdentityInfo.load()
            if identity == nil,
               let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
               assistant.isRemote {
                Task {
                    remoteIdentity = await identityClient.fetchRemoteIdentity()
                }
            }
            resolvePlatformUuid()
            Task { await fetchHealthz() }

            // Advanced dev setup
            macOSFlagStates = MacOSClientFeatureFlagManager.shared.allFlagStates()
            if testerModel == nil, let dc = daemonClient {
                testerModel = ToolPermissionTesterModel(daemonClient: dc)
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
        .alert("Upgrade Assistant", isPresented: $showingInlineUpgradeConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Upgrade") {
                Task { await performInlineUpgrade() }
            }
        } message: {
            Text("Upgrade the assistant to match the desktop app version? The assistant will be briefly unavailable during the upgrade.")
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
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                Text("The assistant will be briefly unavailable.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
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
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                Text("Stopping the assistant and removing local data.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
            .padding(VSpacing.xxl)
            .frame(minWidth: 260)
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $showingEnvVars) {
            SettingsPanelEnvVarsSheet(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        .onDisappear {
            daemonClient?.onEnvVarsResponse = nil
            sentryDismissTask?.cancel()
            revokeApiKeyDismissTask?.cancel()
        }
    }

    // MARK: - Platform URL

    private var platformUrlSection: some View {
        SettingsCard(title: "Platform URL") {
            HStack(spacing: VSpacing.sm) {
                TextField("https://platform.vellum.ai", text: $platformUrlText)
                    .vInputStyle()
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .focused($isPlatformUrlFocused)

                VButton(label: "Save", style: .primary, isDisabled: platformUrlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    store.savePlatformBaseUrl(platformUrlText)
                    isPlatformUrlFocused = false
                }
            }
        }
        .onAppear {
            store.refreshPlatformConfig()
            platformUrlText = store.platformBaseUrl
        }
        .onChange(of: store.platformBaseUrl) { _, newValue in
            if !isPlatformUrlFocused {
                platformUrlText = newValue
            }
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

                let home = assistant.home
                homeRow(home: home)
            }

            if let message = devModeMessage {
                Text(message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.primaryBase)
                    .transition(.opacity)
            }

            if let daemonClient {
                DeveloperDaemonStatusRows(daemonClient: daemonClient)
            }

            healthzInfoRows
        }
    }

    // MARK: - Healthz Info

    private var desktopAppVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// The assistant version reported by the healthz endpoint, if available.
    private var effectiveVersion: String? {
        if let version = healthz?.version, !version.isEmpty {
            return version
        }
        return nil
    }

    private var assistantVersionBehind: Bool {
        guard let assistantVersion = healthz?.version, !assistantVersion.isEmpty,
              let appVersion = desktopAppVersion, !appVersion.isEmpty else {
            return false
        }
        return assistantVersion.compare(appVersion, options: .numeric) == .orderedAscending
    }

    @ViewBuilder
    private var healthzInfoRows: some View {
        // Always show a version row
        HStack(alignment: .top) {
            Text("Version")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            if let version = effectiveVersion {
                Text(version)
                    .font(VFont.mono)
                    .foregroundColor(assistantVersionBehind ? VColor.systemNegativeStrong : VColor.contentDefault)
                    .textSelection(.enabled)

                if assistantVersionBehind {
                    if isUpgradingInline {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        VButton(label: "Upgrade", style: .primary) {
                            showingInlineUpgradeConfirmation = true
                        }
                        .disabled(isUpgradingInline)
                    }
                }
            } else {
                Text("Not available")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
            }

            Spacer()
        }

        if assistantVersionBehind, let appVersion = desktopAppVersion {
            HStack(spacing: VSpacing.xs) {
                Text("Desktop is on")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                Text(appVersion)
                    .font(VFont.mono)
                    .foregroundColor(VColor.primaryBase)
            }
        }

        if let error = inlineUpgradeError {
            Text(error)
                .font(VFont.caption)
                .foregroundColor(VColor.systemNegativeStrong)
        }

        if let success = inlineUpgradeSuccess {
            Text(success)
                .font(VFont.caption)
                .foregroundColor(VColor.systemPositiveStrong)
        }

        if let healthz {
            if let disk = healthz.disk {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(alignment: .center) {
                        Text("Disk")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .frame(width: 100, alignment: .leading)
                        Text("\(formatMb(disk.usedMb)) used of \(formatMb(disk.totalMb))")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
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
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
    }

    private func formatMb(_ mb: Double) -> String {
        if mb >= 1024 {
            return String(format: "%.1f GB", mb / 1024.0)
        }
        return String(format: "%.0f MB", mb)
    }

    private func performInlineUpgrade() async {
        inlineUpgradeError = nil
        inlineUpgradeSuccess = nil
        isUpgradingInline = true
        defer { isUpgradingInline = false }

        do {
            let response = try await GatewayHTTPClient.post(path: "assistants/upgrade")
            if response.isSuccess {
                inlineUpgradeSuccess = "Upgrade initiated. The assistant may be briefly unavailable."
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await fetchHealthz()
            } else {
                inlineUpgradeError = "Upgrade failed (HTTP \(response.statusCode))"
            }
        } catch let error as GatewayHTTPClient.ClientError {
            inlineUpgradeError = error.localizedDescription
        } catch {
            inlineUpgradeError = "Upgrade failed: \(error.localizedDescription)"
        }
    }

    private func fetchHealthz() async {
        do {
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "assistants/\(selectedAssistantId)/healthz",
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
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            Text(value)
                .font(mono ? VFont.mono : VFont.body)
                .foregroundColor(VColor.contentDefault)
                .textSelection(.enabled)

            Spacer()
        }
    }

    @ViewBuilder
    private func homeRow(home: AssistantHome) -> some View {
        HStack(alignment: .top) {
            Text("Home")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(home.displayLabel)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                ForEach(Array(home.displayDetails.enumerated()), id: \.offset) { _, detail in
                    HStack(spacing: VSpacing.xs) {
                        Text(detail.label + ":")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Text(detail.value)
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentSecondary)
                            .textSelection(.enabled)
                    }
                }

                if let uuid = platformUuid {
                    HStack(spacing: VSpacing.xs) {
                        Text("Platform ID:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Text(uuid)
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentSecondary)
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
            return
        }
        let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
        let userId = authManager.currentUser?.id
        platformUuid = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: assistant.assistantId,
            isManaged: assistant.isManaged,
            organizationId: orgId,
            userId: userId,
            credentialStorage: {
                #if DEBUG
                return FileCredentialStorage()
                #else
                return KeychainCredentialStorage()
                #endif
            }()
        )
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
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.contentDefault)
                            Text(displayNames[assistant.assistantId] != nil
                                ? "\(assistant.assistantId) · \(assistant.home.displayLabel)"
                                : assistant.home.displayLabel)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                    .padding(.vertical, VSpacing.xs)
                }

                SettingsDivider()

                HStack {
                    Text("Active")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentSecondary)
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
                let currentId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
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
            }
        }
    }

    private func displayLabel(for assistant: LockfileAssistant) -> String {
        displayNames[assistant.assistantId] ?? assistant.assistantId
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
        _ = try? await GatewayHTTPClient.post(path: "assistants/restart")
    }

    private func performLocalRestart() async {
        do {
            try await AppDelegate.shared?.vellumCli.hatch(
                name: selectedAssistantId,
                daemonOnly: true,
                restart: true
            )
        } catch {}
    }

    // MARK: - SSH Terminal

    private var sshTerminalSection: some View {
        SettingsCard(
            title: "SSH Terminal",
            subtitle: "Open a terminal session to the assistant's host machine."
        ) {
            VButton(label: "Open Terminal", style: .outlined) {
                openTerminalWindow()
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
                    .font(VFont.caption)
                    .foregroundColor(status.starts(with: "Failed") ? VColor.systemNegativeStrong : VColor.systemPositiveStrong)
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
                path: "assistants/{assistantId}/secrets", json: body, timeout: 10
            )
            if response.isSuccess || response.statusCode == 404 {
                // Clear the locally-cached credential so the key is not
                // re-injected on the next daemon restart or bootstrap.
                #if DEBUG
                let credStorage = FileCredentialStorage()
                #else
                let credStorage = KeychainCredentialStorage()
                #endif
                let credentialAccount = LocalAssistantBootstrapService.credentialAccount(for: targetAssistantId)
                _ = credStorage.delete(account: credentialAccount)

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
            VButton(label: "Hatch...", style: .primary) {
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
        guard daemonClient != nil else { return }
        isLoadingAssistantFlags = true
        assistantFlagsError = nil
        do {
            assistantFlags = try await featureFlagClient.getFeatureFlags()
        } catch {
            assistantFlagsError = error.localizedDescription
        }
        isLoadingAssistantFlags = false
    }

    private var unifiedFlags: [UnifiedFeatureFlag] {
        let fromAssistant: [UnifiedFeatureFlag] = assistantFlags.map { flag in
            UnifiedFeatureFlag(
                id: flag.key,
                key: flag.key,
                label: flag.displayName,
                description: flag.description ?? "",
                defaultEnabled: flag.defaultEnabled ?? true,
                enabled: flag.enabled,
                scope: .assistant
            )
        }
        let fromMacOS: [UnifiedFeatureFlag] = macOSFlagStates.map { state in
            UnifiedFeatureFlag(
                id: state.key,
                key: state.key,
                label: state.label,
                description: state.description,
                defaultEnabled: state.defaultEnabled,
                enabled: state.enabled,
                scope: .macos
            )
        }
        return (fromAssistant + fromMacOS).sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    private var filteredUnifiedFlags: [UnifiedFeatureFlag] {
        var flags = unifiedFlags
        if featureFlagScopeFilter == "assistant" {
            flags = flags.filter { $0.scope == .assistant }
        } else if featureFlagScopeFilter == "macos" {
            flags = flags.filter { $0.scope == .macos }
        }
        if !featureFlagSearchText.isEmpty {
            flags = flags.filter { flag in
                flag.label.localizedCaseInsensitiveContains(featureFlagSearchText) ||
                flag.description.localizedCaseInsensitiveContains(featureFlagSearchText) ||
                flag.key.localizedCaseInsensitiveContains(featureFlagSearchText)
            }
        }
        return flags
    }

    private var featureFlagSection: some View {
        SettingsCard(title: "Feature Flags", subtitle: "Toggle feature flags for the assistant and macOS app.") {
            HStack(spacing: VSpacing.sm) {
                VSearchBar(placeholder: "Search flags...", text: $featureFlagSearchText)
                VDropdown(
                    placeholder: "All",
                    selection: $featureFlagScopeFilter,
                    options: [
                        (label: "All", value: "all"),
                        (label: "Assistant", value: "assistant"),
                        (label: "macOS", value: "macos")
                    ],
                    maxWidth: 130
                )
            }

            if isLoadingAssistantFlags {
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }
            }

            if let error = assistantFlagsError {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.systemNegativeHover)
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                }
            }

            if unifiedFlags.isEmpty && !isLoadingAssistantFlags {
                Text("No feature flags available.")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
            } else if filteredUnifiedFlags.isEmpty && (!featureFlagSearchText.isEmpty || featureFlagScopeFilter != "all") {
                Text("No matching flags.")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
            } else {
                ForEach(filteredUnifiedFlags) { flag in
                    unifiedFlagRow(flag: flag)
                }
            }
        }
    }

    private func unifiedFlagRow(flag: UnifiedFeatureFlag) -> some View {
        let flagBinding = Binding<Bool>(
            get: {
                switch flag.scope {
                case .assistant:
                    return assistantFlags.first(where: { $0.key == flag.key })?.enabled ?? flag.enabled
                case .macos:
                    return macOSFlagStates.first(where: { $0.key == flag.key })?.enabled ?? flag.enabled
                }
            },
            set: { newValue in
                switch flag.scope {
                case .assistant:
                    if let index = assistantFlags.firstIndex(where: { $0.key == flag.key }) {
                        assistantFlags[index] = AssistantFeatureFlag(
                            key: flag.key,
                            enabled: newValue,
                            defaultEnabled: flag.defaultEnabled,
                            description: flag.description.isEmpty ? nil : flag.description,
                            label: flag.label
                        )
                    }
                    NotificationCenter.default.post(
                        name: .assistantFeatureFlagDidChange,
                        object: nil,
                        userInfo: ["key": flag.key, "enabled": newValue]
                    )
                    Task {
                        do {
                            try await featureFlagClient.setFeatureFlag(key: flag.key, enabled: newValue)
                        } catch {
                            if let index = assistantFlags.firstIndex(where: { $0.key == flag.key }) {
                                assistantFlags[index] = AssistantFeatureFlag(
                                    key: flag.key,
                                    enabled: !newValue,
                                    defaultEnabled: flag.defaultEnabled,
                                    description: flag.description.isEmpty ? nil : flag.description,
                                    label: flag.label
                                )
                            }
                            NotificationCenter.default.post(
                                name: .assistantFeatureFlagDidChange,
                                object: nil,
                                userInfo: ["key": flag.key, "enabled": !newValue]
                            )
                        }
                    }
                case .macos:
                    if let index = macOSFlagStates.firstIndex(where: { $0.key == flag.key }) {
                        macOSFlagStates[index].enabled = newValue
                    }
                    MacOSClientFeatureFlagManager.shared.setOverride(flag.key, enabled: newValue)
                    NotificationCenter.default.post(
                        name: .assistantFeatureFlagDidChange,
                        object: nil,
                        userInfo: ["key": flag.key, "enabled": newValue]
                    )
                }
            }
        )
        return HStack(alignment: .top, spacing: VSpacing.sm) {
            VToggle(isOn: flagBinding)
                .accessibilityLabel(flag.label)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.xs) {
                    Text(flag.label)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                    VBadge(label: flag.scope == .assistant ? "Assistant" : "macOS",
                           tone: flag.scope == .assistant ? .accent : .neutral,
                           emphasis: .subtle)
                }
                if !flag.description.isEmpty {
                    Text(flag.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                HStack(spacing: VSpacing.xxs) {
                    Text("Default:")
                        .font(VFont.small)
                        .foregroundColor(VColor.contentTertiary)
                    VBadge(label: flag.defaultEnabled ? "On" : "Off",
                           tone: flag.defaultEnabled ? .danger : .neutral,
                           emphasis: .subtle)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { flagBinding.wrappedValue.toggle() } }
    }

    // MARK: - Environment Variables

    @ViewBuilder
    private var environmentVariablesSection: some View {
        if daemonClient != nil {
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
                        .foregroundColor(VColor.systemNegativeHover)
                    Text("Share Diagnostics is disabled. Non-fatal events will be silently dropped unless you enable \"Share Diagnostics\" in the Privacy tab.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeHover)
                }
            }

            if let status = lastSentryStatus {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundColor(VColor.systemPositiveStrong)
                    Text(status)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemPositiveStrong)
                }
                .transition(.opacity)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Trigger Fatal Crash", style: .danger) {
                        fatalError("Sentry test crash")
                    }
                    Text("Calls fatalError() — will terminate the app immediately.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Error", style: .outlined) {
                        sendSentryTestEvent(level: .error, label: "error")
                    }
                    Text("Captures a Sentry event with level .error")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Warning", style: .outlined) {
                        sendSentryTestEvent(level: .warning, label: "warning")
                    }
                    Text("Captures a Sentry event with level .warning")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Message", style: .outlined) {
                        sendSentryTestEvent(level: .info, label: "info message")
                    }
                    Text("Captures a Sentry event with level .info")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
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
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
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

private struct DeveloperDaemonStatusRows: View {
    @ObservedObject var daemonClient: DaemonClient

    var body: some View {
        statusRow(
            label: "Assistant",
            isHealthy: daemonClient.isConnected,
            detail: daemonClient.isConnected
                ? "Connected" + (daemonClient.daemonVersion.map { " (v\($0))" } ?? "")
                : "Disconnected"
        )

        if let memoryStatus = daemonClient.latestMemoryStatus {
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
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 100, alignment: .leading)

            Circle()
                .fill(isHealthy ? VColor.systemPositiveStrong : VColor.systemNegativeStrong)
                .frame(width: 8, height: 8)

            Text(detail)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            Spacer()
        }
    }
}
