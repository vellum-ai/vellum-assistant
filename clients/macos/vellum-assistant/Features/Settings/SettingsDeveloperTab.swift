import Foundation
import SwiftUI
@preconcurrency import Sentry
import VellumAssistantShared

/// Developer settings tab — consolidates all internal tooling: assistant info,
/// switching/wake controls, gateway settings, hatch, retire, advanced dev tools
/// (permission simulator, feature flags, env vars), and Sentry testing.
@MainActor
struct SettingsDeveloperTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
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
    @State private var isHatchFlagEnabled: Bool = true
    @State private var isLoadingHatchFlag: Bool = false
    @State private var showingHatchConfirmation: Bool = false
    @State private var displayNames: [String: String] = [:]
    @State private var awakeStates: [String: Bool] = [:]
    @State private var transitioningStates: Set<String> = []

    // -- Advanced dev state --
    @State private var macOSFlagStates: [MacOSFeatureFlagState] = []
    @State private var assistantFlags: [DaemonClient.AssistantFeatureFlag] = []
    @State private var assistantFlagsError: String?
    @State private var isLoadingAssistantFlags = false
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    @State private var testerModel: ToolPermissionTesterModel?

    // -- Sentry testing state --
    @State private var lastSentryStatus: String?
    @State private var sentryDismissTask: Task<Void, Never>?
    @State private var isSentryEnabled: Bool = true

    private static let hatchNewAssistantFlagKey = "feature_flags.hatch-new-assistant.enabled"

    @State private var platformUrlText: String = ""
    @FocusState private var isPlatformUrlFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Platform URL
            platformUrlSection
            // Assistant Info
            assistantInfoSection
            // Switch Assistant
            switchAssistantSection
            // Gateway Settings
            GatewaySettingsCard(
                store: store,
                daemonClient: daemonClient,
                isManaged: lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId })?.isManaged ?? false
            )
            // Hatch New Assistant
            hatchNewAssistantSection
            // Retire Assistant
            retireAssistantSection

            // Permission Simulator
            if let model = testerModel {
                ToolPermissionTesterView(model: model)
            }

            // Assistant Feature Flags
            assistantFeatureFlagSection
            // macOS Feature Flags
            macOSFeatureFlagSection
            // Environment Variables
            environmentVariablesSection
            // Sentry Testing
            sentryTestingSection
        }
        .onAppear {
            // Assistant info setup
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
            refreshAwakeStates()
            refreshDisplayNames()
            identity = IdentityInfo.load()
            if identity == nil,
               let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
               assistant.isRemote {
                Task {
                    remoteIdentity = await daemonClient?.fetchRemoteIdentity()
                }
            }
            Task { await loadHatchFlag() }

            // Advanced dev setup
            macOSFlagStates = MacOSClientFeatureFlagManager.shared.allFlagStates()
            if testerModel == nil, let dc = daemonClient {
                testerModel = ToolPermissionTesterModel(daemonClient: dc)
            }
            Task { await loadAssistantFlags() }

            // Sentry setup
            isSentryEnabled = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
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
                Text("This will stop the assistant daemon, remove local data, and return to initial setup. This action cannot be undone.")
            }
        }
        .sheet(isPresented: $isRetiring) {
            VStack(spacing: VSpacing.lg) {
                ProgressView()
                    .controlSize(.regular)
                    .progressViewStyle(.circular)
                Text("Retiring assistant...")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Text("Stopping the daemon and removing local data.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
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
        }
    }

    // MARK: - Platform URL

    private var platformUrlSection: some View {
        SettingsCard(title: "Platform URL") {
            HStack(spacing: VSpacing.sm) {
                TextField("https://platform.vellum.ai", text: $platformUrlText)
                    .vInputStyle()
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .focused($isPlatformUrlFocused)

                VButton(label: "Save", style: .primary, size: .medium, isDisabled: platformUrlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
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
                            store.toggleDevMode()
                            devModeTapCount = 0
                            devModeMessage = store.isDevMode
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
                    .foregroundColor(VColor.accent)
                    .transition(.opacity)
            }

            if let daemonClient {
                DeveloperDaemonStatusRows(daemonClient: daemonClient)
            }
        }
    }

    private func infoRow(label: String, value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 100, alignment: .leading)

            Text(value)
                .font(mono ? VFont.mono : VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)

            Spacer()
        }
    }

    @ViewBuilder
    private func homeRow(home: AssistantHome) -> some View {
        HStack(alignment: .top) {
            Text("Home")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 100, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(home.displayLabel)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                ForEach(Array(home.displayDetails.enumerated()), id: \.offset) { _, detail in
                    HStack(spacing: VSpacing.xs) {
                        Text(detail.label + ":")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                        Text(detail.value)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textSecondary)
                            .textSelection(.enabled)
                    }
                }
            }

            Spacer()
        }
    }

    // MARK: - Switch Assistant

    @ViewBuilder
    private var switchAssistantSection: some View {
        if lockfileAssistants.count > 1 {
            SettingsCard(title: "Assistants") {
                ForEach(lockfileAssistants, id: \.assistantId) { assistant in
                    HStack(spacing: VSpacing.sm) {
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            Text(displayLabel(for: assistant))
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.textPrimary)
                            Text(displayNames[assistant.assistantId] != nil
                                ? "\(assistant.assistantId) · \(assistant.home.displayLabel)"
                                : assistant.home.displayLabel)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
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
                    }
                    .padding(.vertical, VSpacing.xs)
                }

                SettingsDivider()

                HStack {
                    Text("Active")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    VDropdown(
                        placeholder: "",
                        selection: $selectedAssistantId,
                        options: awakeAssistants.map { (label: displayLabel(for: $0), value: $0.assistantId) }
                    )
                    .frame(maxWidth: 200)
                }
            }
            .onChange(of: selectedAssistantId) { oldValue, newValue in
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

    private func refreshAwakeStates() {
        for assistant in lockfileAssistants {
            if assistant.isRemote {
                awakeStates[assistant.assistantId] = true
            } else {
                let env: [String: String]? = assistant.instanceDir.map { ["BASE_DATA_DIR": $0] }
                awakeStates[assistant.assistantId] = DaemonClient.isDaemonProcessAlive(environment: env)
            }
        }
    }

    private func toggleAwakeState(assistant: LockfileAssistant, awake: Bool) {
        guard !assistant.isRemote else { return }
        guard let cli = AppDelegate.shared?.assistantCli else { return }

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
                let env: [String: String]? = assistant.instanceDir.map { ["BASE_DATA_DIR": $0] }
                awakeStates[assistant.assistantId] = DaemonClient.isDaemonProcessAlive(environment: env)
            }
            transitioningStates.remove(assistant.assistantId)
        }
    }

    private func switchToAssistant(_ assistant: LockfileAssistant) {
        AppDelegate.shared?.performSwitchAssistant(to: assistant)
        onClose()
    }

    // MARK: - Retire Assistant

    private var retireAssistantSection: some View {
        SettingsCard(
            title: "Retire Assistant",
            subtitle: lockfileAssistants.count > 1
                ? "Stops the current assistant and switches to another."
                : "Stops the daemon, removes local data, and returns to initial setup."
        ) {
            VButton(label: "Retire", style: .danger, size: .medium) {
                showingRetireConfirmation = true
            }
        }
    }

    // MARK: - Hatch New Assistant

    private func loadHatchFlag() async {
        guard let daemonClient else { return }
        isLoadingHatchFlag = true
        do {
            let flags = try await daemonClient.getFeatureFlags()
            if let hatchFlag = flags.first(where: { $0.key == Self.hatchNewAssistantFlagKey }) {
                isHatchFlagEnabled = hatchFlag.enabled
                isLoadingHatchFlag = false
                return
            }
        } catch {}

        let config = WorkspaceConfigIO.read()
        if let canonicalFlags = config["assistantFeatureFlagValues"] as? [String: Bool] {
            if let enabled = canonicalFlags[Self.hatchNewAssistantFlagKey] {
                isHatchFlagEnabled = enabled
                isLoadingHatchFlag = false
                return
            }
        }
        isHatchFlagEnabled = true
        isLoadingHatchFlag = false
    }

    @ViewBuilder
    private var hatchNewAssistantSection: some View {
        if isHatchFlagEnabled {
            SettingsCard(title: "Hatch New Assistant", subtitle: "Starts the initial setup flow to create a new assistant.") {
                VButton(label: "Hatch...", style: .primary, size: .medium) {
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
    }

    // MARK: - Assistant Feature Flags

    private func loadAssistantFlags() async {
        guard let daemonClient else { return }
        isLoadingAssistantFlags = true
        assistantFlagsError = nil
        do {
            assistantFlags = try await daemonClient.getFeatureFlags()
        } catch {
            assistantFlagsError = error.localizedDescription
        }
        isLoadingAssistantFlags = false
    }

    private var assistantFeatureFlagSection: some View {
        SettingsCard(title: "Assistant Feature Flags", subtitle: "Sourced from the gateway API. Changes are synced remotely.") {
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
                        .foregroundColor(VColor.warning)
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                }
            } else if assistantFlags.isEmpty && !isLoadingAssistantFlags {
                Text("No assistant feature flags available.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(assistantFlags) { flag in
                    assistantFlagRow(flag: flag)
                }
            }
        }
    }

    private func assistantFlagRow(flag: DaemonClient.AssistantFeatureFlag) -> some View {
        let flagBinding = Binding<Bool>(
            get: {
                assistantFlags.first(where: { $0.key == flag.key })?.enabled ?? flag.enabled
            },
            set: { newValue in
                if let index = assistantFlags.firstIndex(where: { $0.key == flag.key }) {
                    assistantFlags[index] = DaemonClient.AssistantFeatureFlag(
                        key: flag.key,
                        enabled: newValue,
                        defaultEnabled: flag.defaultEnabled,
                        description: flag.description,
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
                        try await daemonClient?.setFeatureFlag(key: flag.key, enabled: newValue)
                    } catch {
                        if let index = assistantFlags.firstIndex(where: { $0.key == flag.key }) {
                            assistantFlags[index] = DaemonClient.AssistantFeatureFlag(
                                key: flag.key,
                                enabled: !newValue,
                                defaultEnabled: flag.defaultEnabled,
                                description: flag.description,
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
            }
        )
        return HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(flag.displayName)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                if let description = flag.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
            Spacer()
            VToggle(isOn: flagBinding)
                .accessibilityLabel(flag.displayName)
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { flagBinding.wrappedValue.toggle() } }
    }

    // MARK: - macOS Feature Flags

    private var macOSFeatureFlagSection: some View {
        SettingsCard(title: "macOS Feature Flags", subtitle: "Local-only flags stored in UserDefaults on this Mac.") {
            if macOSFlagStates.isEmpty {
                Text("No macOS feature flags available.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(Array(macOSFlagStates.enumerated()), id: \.element.id) { index, entry in
                    macOSFlagRow(index: index, entry: entry)
                }
            }
        }
    }

    private func macOSFlagRow(index: Int, entry: MacOSFeatureFlagState) -> some View {
        let flagBinding = Binding<Bool>(
            get: { macOSFlagStates[index].enabled },
            set: { newValue in
                macOSFlagStates[index].enabled = newValue
                MacOSClientFeatureFlagManager.shared.setOverride(entry.key, enabled: newValue)
                NotificationCenter.default.post(
                    name: .assistantFeatureFlagDidChange,
                    object: nil,
                    userInfo: ["key": entry.key, "enabled": newValue]
                )
            }
        )
        return HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(entry.label)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                if !entry.description.isEmpty {
                    Text(entry.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
            Spacer()
            VToggle(isOn: flagBinding)
                .accessibilityLabel(entry.label)
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { flagBinding.wrappedValue.toggle() } }
    }

    // MARK: - Environment Variables

    @ViewBuilder
    private var environmentVariablesSection: some View {
        if daemonClient != nil {
            SettingsCard(title: "Environment Variables", subtitle: "View env vars for both the app and daemon processes") {
                VButton(label: "View", style: .secondary, size: .medium) {
                        appEnvVars = ProcessInfo.processInfo.environment
                            .sorted(by: { $0.key < $1.key })
                            .map { ($0.key, $0.value) }
                        daemonEnvVars = []
                        daemonClient?.onEnvVarsResponse = { response in
                            Task { @MainActor in
                                self.daemonEnvVars = response.vars
                                    .sorted(by: { $0.key < $1.key })
                                    .map { ($0.key, $0.value) }
                            }
                        }
                        try? daemonClient?.sendEnvVarsRequest()
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
                        .foregroundColor(VColor.warning)
                    Text("Usage data collection is disabled. Non-fatal events will be silently dropped unless you enable \"Collect usage data\" in the Privacy tab.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.warning)
                }
            }

            if let status = lastSentryStatus {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundColor(VColor.success)
                    Text(status)
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                }
                .transition(.opacity)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Trigger Fatal Crash", style: .danger, size: .medium) {
                        fatalError("Sentry test crash")
                    }
                    Text("Calls fatalError() — will terminate the app immediately.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Error", style: .secondary, size: .medium) {
                        sendSentryTestEvent(level: .error, label: "error")
                    }
                    Text("Captures a Sentry event with level .error")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Warning", style: .secondary, size: .medium) {
                        sendSentryTestEvent(level: .warning, label: "warning")
                    }
                    Text("Captures a Sentry event with level .warning")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Message", style: .secondary, size: .medium) {
                        sendSentryTestEvent(level: .info, label: "info message")
                    }
                    Text("Captures a Sentry event with level .info")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                SettingsDivider()

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Test Performance Transaction", style: .secondary, size: .medium) {
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
                        .foregroundColor(VColor.textMuted)
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
            label: "Daemon",
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
                .foregroundColor(VColor.textMuted)
                .frame(width: 100, alignment: .leading)

            Circle()
                .fill(isHealthy ? VColor.success : VColor.error)
                .frame(width: 8, height: 8)

            Text(detail)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            Spacer()
        }
    }
}
