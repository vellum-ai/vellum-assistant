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

    /// Whether the hatch new assistant feature flag is enabled.
    /// Defaults to `true` until the gateway responds. Once the gateway response
    /// arrives, this reflects the value of `feature_flags.hatch_new_assistant.enabled`.

    private static let hatchNewAssistantFlagKey = "feature_flags.hatch_new_assistant.enabled"

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
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
            Task { await store.checkVellumPlatform() }
            platformUrlText = store.platformBaseUrl
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
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
        .onChange(of: isPlatformUrlFocused) { _, focused in
            if !focused {
                platformUrlText = store.platformBaseUrl
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
            Text("Account")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if store.isDevMode {
                Text("Platform URL")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                HStack(spacing: VSpacing.sm) {
                    TextField("https://platform.vellum.ai", text: $platformUrlText)
                        .focused($isPlatformUrlFocused)
                        .vInputStyle()
                        .font(VFont.mono)
                        .onSubmit {
                            store.savePlatformBaseUrl(platformUrlText)
                            Task { await store.checkVellumPlatform() }
                        }
                    VButton(label: "Save", style: .primary) {
                        store.savePlatformBaseUrl(platformUrlText)
                        Task { await store.checkVellumPlatform() }
                    }
                }
            }

            // Platform connection status
            ConnectionStatusRow(
                label: "Platform",
                status: platformStatusInfo,
                isRefreshing: store.isCheckingVellumPlatform,
                lastChecked: store.platformLastChecked
            ) {
                Task { await store.checkVellumPlatform() }
            }

            Divider().background(VColor.surfaceBorder)

            if authManager.isLoading {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .foregroundColor(VColor.textMuted)
                        .font(.system(size: 14))
                    Text("Checking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if let user = authManager.currentUser {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text(user.email ?? user.display ?? "Signed in")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    VButton(label: "Log Out", style: .danger) {
                        Task { await authManager.logout() }
                    }
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "xmark.circle")
                        .foregroundColor(VColor.textMuted)
                        .font(.system(size: 14))
                    Text("Not signed in")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    VButton(
                        label: authManager.isSubmitting ? "Signing in..." : "Log In",
                        style: .primary
                    ) {
                        Task { await authManager.startWorkOSLogin() }
                    }
                    .disabled(authManager.isSubmitting)
                }
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
    }

    // MARK: - Platform Status

    private var platformStatusInfo: ConnectionStatusInfo {
        guard let reachable = store.vellumPlatformReachable else {
            return ConnectionStatusInfo(label: "Unknown", color: VColor.textMuted, icon: "questionmark.circle.fill")
        }
        if reachable {
            return ConnectionStatusInfo(label: "Reachable", color: VColor.success, icon: "checkmark.circle.fill")
        } else {
            return ConnectionStatusInfo(label: store.vellumPlatformError ?? "Unreachable", color: VColor.error, icon: "xmark.circle.fill")
        }
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
        .vCard(background: VColor.surfaceSubtle)
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
                Text("Switch Assistant")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                ForEach(lockfileAssistants, id: \.assistantId) { assistant in
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: assistant.assistantId == selectedAssistantId
                              ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(assistant.assistantId == selectedAssistantId
                                             ? VColor.accent : VColor.textMuted)
                            .font(.system(size: 16))

                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            Text(assistant.assistantId)
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.textPrimary)
                            Text(assistant.home.displayLabel)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }

                        Spacer()

                        if assistant.assistantId != selectedAssistantId {
                            VButton(label: "Switch", style: .primary) {
                                switchToAssistant(assistant)
                            }
                        } else {
                            Text("Active")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                    .padding(.vertical, VSpacing.xs)
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
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

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Retire this assistant")
                        .font(VFont.body)
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
                Spacer()
                VButton(label: "Retire...", style: .danger) {
                    showingRetireConfirmation = true
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
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
        if let canonicalFlags = config["assistantFeatureFlagValues"] as? [String: Bool],
           let enabled = canonicalFlags[Self.hatchNewAssistantFlagKey] {
            isHatchFlagEnabled = enabled
            isLoadingHatchFlag = false
            return
        }

        // Check legacy featureFlags section
        if let featureFlags = config["featureFlags"] as? [String: Any] {
            let legacyKeys = [
                "skills.hatch_new_assistant.enabled",
                "skills.hatch-new-assistant.enabled"
            ]
            for key in legacyKeys {
                if let enabled = featureFlags[key] as? Bool {
                    isHatchFlagEnabled = enabled
                    isLoadingHatchFlag = false
                    return
                }
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

                HStack {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Hatch a new assistant")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Text("Starts the initial setup flow to create a new assistant.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                    VButton(label: "Hatch...", style: .primary) {
                        AppDelegate.shared?.replayOnboarding()
                        onClose()
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
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
