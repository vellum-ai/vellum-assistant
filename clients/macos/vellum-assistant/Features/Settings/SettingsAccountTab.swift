import Foundation
import SwiftUI
import VellumAssistantShared

/// Account settings tab — sign-in/out, assistant identity, switch/retire/hatch.
@MainActor
struct SettingsAccountTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    var authManager: AuthManager
    var onClose: () -> Void

    // -- Account / Vellum section state --
    @State private var platformUrlText: String = ""
    @FocusState private var isPlatformUrlFocused: Bool

    // -- Assistant Info state (from SettingsAdvancedTab) --
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

    // -- Wake/sleep toggle state --
    @State private var awakeStates: [String: Bool] = [:]
    @State private var transitioningStates: Set<String> = []

    /// Whether the hatch new assistant feature flag is enabled.
    /// Defaults to `true` until the gateway responds. Once the gateway response
    /// arrives, this reflects the value of `feature_flags.hatch-new-assistant.enabled`.

    private static let hatchNewAssistantFlagKey = "feature_flags.hatch-new-assistant.enabled"

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            accountSection
            assistantInfoSection
            switchAssistantSection
            GatewaySettingsCard(store: store, daemonClient: daemonClient)
            hatchNewAssistantSection
            retireAssistantSection
        }
        .onAppear {
            Task { await authManager.checkSession() }
            store.refreshPlatformConfig()
            platformUrlText = store.platformBaseUrl
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
            refreshAwakeStates()
            identity = IdentityInfo.load()
            if identity == nil,
               let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
               assistant.isRemote {
                Task {
                    remoteIdentity = await daemonClient?.fetchRemoteIdentity()
                }
            }
            Task { await loadHatchFlag() }
        }
        .onChange(of: store.platformBaseUrl) { _, newValue in
            if !isPlatformUrlFocused {
                platformUrlText = newValue
            }
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
    }

    // MARK: - Account Section

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Account & Platform")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Platform URL")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            TextField("https://platform.vellum.ai", text: $platformUrlText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .focused($isPlatformUrlFocused)

            VButton(label: "Save", style: .primary) {
                store.savePlatformBaseUrl(platformUrlText)
                isPlatformUrlFocused = false
            }
            .disabled(platformUrlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Divider().background(VColor.surfaceBorder)

            Text("Sign in to Your Account")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            if authManager.isLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Checking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if authManager.currentUser != nil {
                VButton(label: "Log Out", style: .danger) {
                    Task { await authManager.logout() }
                }
            } else {
                VButton(
                    label: authManager.isSubmitting ? "Signing in..." : "Sign In",
                    style: .primary
                ) {
                    Task { await authManager.startWorkOSLogin() }
                }
                .disabled(authManager.isSubmitting)
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Assistant Info

    private var assistantInfoSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Assistant Info")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

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

            // Process status (child view observes @Published changes)
            if let daemonClient {
                AccountDaemonStatusRows(daemonClient: daemonClient)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
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
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Assistants")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                ForEach(lockfileAssistants, id: \.assistantId) { assistant in
                    HStack(spacing: VSpacing.sm) {
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            Text(assistant.assistantId)
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.textPrimary)
                            Text(assistant.home.displayLabel)
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

                Divider().background(VColor.surfaceBorder)

                HStack {
                    Text("Active")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Picker("", selection: $selectedAssistantId) {
                        ForEach(awakeAssistants, id: \.assistantId) { assistant in
                            Text(assistant.assistantId).tag(assistant.assistantId)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 200)
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onChange(of: selectedAssistantId) { oldValue, newValue in
                // Skip if reverting to current or unchanged
                let currentId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
                guard newValue != currentId, newValue != oldValue else { return }
                guard let assistant = lockfileAssistants.first(where: { $0.assistantId == newValue }) else { return }
                // Only switch if the selected assistant is awake
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
        // Remote assistants are always awake — can't toggle
        if assistant.isRemote { return true }
        // Mid-transition — prevent double-toggle
        if transitioningStates.contains(assistant.assistantId) { return true }
        return false
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
                // If we just slept the active assistant, auto-switch to
                // another awake one so the app stays connected.
                if !awake && assistant.assistantId == selectedAssistantId {
                    if let next = lockfileAssistants.first(where: {
                        $0.assistantId != assistant.assistantId && (awakeStates[$0.assistantId] ?? false)
                    }) {
                        switchToAssistant(next)
                        selectedAssistantId = next.assistantId
                    }
                }
            } catch {
                // On failure, re-check actual state
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
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Retire Assistant")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Retire this assistant")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)
                    if lockfileAssistants.count > 1 {
                        Text("Stops the current assistant and switches to another.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    } else {
                        Text("Stops the daemon, removes local data, and returns to initial setup.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                }
                VButton(label: "Retire", style: .danger) {
                    showingRetireConfirmation = true
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Hatch New Assistant

    /// Fetch the hatch-new-assistant flag from the gateway API.
    /// Falls back to the local workspace config if the gateway is unreachable.
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
        } catch {
            // Gateway unreachable — fall through to local config fallback
        }

        // Fallback: read from local workspace config
        let config = WorkspaceConfigIO.read()

        // Check canonical assistantFeatureFlagValues first (new format)
        if let canonicalFlags = config["assistantFeatureFlagValues"] as? [String: Bool] {
            if let enabled = canonicalFlags[Self.hatchNewAssistantFlagKey] {
                isHatchFlagEnabled = enabled
                isLoadingHatchFlag = false
                return
            }
        }
        // On failure, default to showing the hatch section
        isHatchFlagEnabled = true
        isLoadingHatchFlag = false
    }

    @ViewBuilder
    private var hatchNewAssistantSection: some View {
        if isHatchFlagEnabled {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Hatch New Assistant")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Hatch a new assistant")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)
                        Text("Starts the initial setup flow to create a new assistant.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
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
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Daemon Status Rows

/// Extracted child view so SwiftUI observes `DaemonClient`'s `@Published`
/// properties and re-renders when connection or memory status changes.
private struct AccountDaemonStatusRows: View {
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
