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

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            accountSection
            assistantInfoSection
            switchAssistantSection
            GatewaySettingsCard(store: store, daemonClient: daemonClient)
            retireAssistantSection
            hatchNewAssistantSection
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

            if store.isDevMode {
                Divider().background(VColor.surfaceBorder)

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

            Divider().background(VColor.surfaceBorder)

            // Platform connection status
            HStack(spacing: VSpacing.sm) {
                Text("Platform")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                Spacer()
                if store.isCheckingVellumPlatform {
                    ProgressView().controlSize(.small)
                } else if let reachable = store.vellumPlatformReachable {
                    Image(systemName: reachable ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundColor(reachable ? VColor.success : VColor.error)
                        .font(.system(size: 12))
                    Text(reachable ? "Reachable" : (store.vellumPlatformError ?? "Unreachable"))
                        .font(VFont.caption)
                        .foregroundColor(reachable ? VColor.success : VColor.error)
                }
                Button {
                    Task { await store.checkVellumPlatform() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
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

    @ViewBuilder
    private var hatchNewAssistantSection: some View {
        if FeatureFlagManager.shared.isEnabled(.hatchNewAssistantEnabled) {
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
