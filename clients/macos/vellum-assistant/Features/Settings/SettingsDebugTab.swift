import SwiftUI
import VellumAssistantShared

/// Debug settings tab for cloud-hosted/platform-managed assistants. Surfaces
/// operational controls — restarting the assistant pod and opening an SSH
/// terminal into the workspace volume via recovery mode — without requiring
/// the developer feature flag to be enabled.
@MainActor
struct SettingsDebugTab: View {
    @ObservedObject var store: SettingsStore

    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""

    @State private var showingRestartConfirmation: Bool = false
    @State private var isRestarting: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            restartAssistantSection
            sshTerminalSection
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""
            Task {
                let assistants = await Task.detached { LockfileAssistant.loadAll() }.value
                lockfileAssistants = assistants
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
        // Bail out if we don't have a real assistant. Without this guard an
        // empty `selectedAssistantId` would POST to `assistants//restart`,
        // silently fail under `try?`, and leave the user staring at the
        // "Restarting…" sheet as if everything succeeded.
        guard lockfileAssistants.contains(where: { $0.assistantId == selectedAssistantId }) else { return }
        _ = try? await GatewayHTTPClient.post(path: "assistants/\(selectedAssistantId)/restart")
        try? await Task.sleep(nanoseconds: 2_000_000_000)
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
            recoveryModeStatusRow

            SettingsDivider()

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

    private func openTerminalWindow() {
        guard let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }),
              assistant.isManaged else { return }
        SSHTerminalWindow.shared.open(assistant: assistant)
    }
}
