import SwiftUI
import VellumAssistantShared

/// Result of an in-place update check in the About panel.
private enum UpdateCheckResult {
    case upToDate
    case updateAvailable(version: String)
    case notAvailable(String)
    case error
}

/// Custom About Vellum panel that replaces the native macOS About panel.
/// Shows the app icon, client version, service group version with topology
/// label, commit SHA, architecture, and an in-place "Check for Updates" button.
@MainActor
struct AboutVellumView: View {
    var connectionManager: GatewayConnectionManager?

    @State private var healthz: DaemonHealthz?
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""
    @State private var isCheckingForUpdates = false
    @State private var updateCheckResult: UpdateCheckResult?

    /// The current assistant's topology.
    private var topology: AssistantTopology {
        guard let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) else {
            return .local
        }
        return assistant.isDocker ? .docker
            : assistant.isManaged ? .managed
            : assistant.cloud.lowercased() == "local" ? .local
            : .remote
    }

    /// Resolved service group version — prefers the reactive connectionManager value,
    /// falls back to the one-shot health fetch.
    private var serviceVersion: String? {
        connectionManager?.assistantVersion ?? healthz?.version
    }

    /// Whether the client and service-group versions are semantically equal
    /// (major.minor.patch). Pre-release suffixes (e.g., `-beta.1`) are
    /// intentionally ignored — only the release triple matters for the
    /// "versions match" checkmark in the About window.
    private var versionsMatch: Bool {
        guard let sgVersion = serviceVersion, !sgVersion.isEmpty,
              let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let sgParsed = VersionCompat.parse(sgVersion),
              let appParsed = VersionCompat.parse(appVersion) else {
            return false
        }
        return sgParsed.coreEquals(appParsed)
    }

    /// Label for the update action button.
    /// Shows "Update in Settings" when there is a service group update to manage,
    /// otherwise plain "Update" for Sparkle-only client app updates.
    private var updateButtonLabel: String {
        if topology == .local {
            return "Update"
        }
        if AppDelegate.shared?.updateManager.isServiceGroupUpdateAvailable == true {
            return "Update in Settings"
        }
        return "Update"
    }

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            // App Icon
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 80, height: 80)

            // App Name
            Text(AppDelegate.appName)
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentEmphasized)

            // Client Version
            if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                Text("Version \(version)")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
            }

            // Service Group Version — only for non-local topologies
            if topology != .local {
                Divider()
                serviceGroupRow
            }

            // Update check result
            updateCheckResultView

            Divider()

            // Metadata: commit SHA + architecture in a compact single line
            metadataRow

            // Environment label (omitted in production)
            if let envLabel = VellumEnvironment.current.displayLabel {
                VStack(spacing: VSpacing.xs) {
                    Text(envLabel)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemMidStrong)
                    Text(Bundle.main.bundlePath.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
            }

            // Check for Updates button — handles check in-place
            VButton(
                label: isCheckingForUpdates ? "Checking..." : "Check for Updates",
                style: .outlined,
                isDisabled: isCheckingForUpdates
            ) {
                Task { await performUpdateCheck() }
            }
        }
        .frame(width: 320)
        .padding(VSpacing.xxl)
        .multilineTextAlignment(.center)
        .background(VColor.surfaceBase)
        .onAppear {
            selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""
            Task {
                let assistants = await Task.detached { LockfileAssistant.loadAll() }.value
                lockfileAssistants = assistants
                await fetchHealthz()
            }
        }
    }

    // MARK: - Service Group Row

    @ViewBuilder
    private var serviceGroupRow: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Service Group")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

            if let version = serviceVersion, !version.isEmpty {
                Text(version)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)

                Text("(\(topologyLabel(topology)))")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)

                if versionsMatch {
                    VIconView(.circleCheck, size: 14)
                        .foregroundStyle(VColor.systemPositiveStrong)
                }
            } else {
                Text("Not connected")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Update Check Result

    @ViewBuilder
    private var updateCheckResultView: some View {
        if isCheckingForUpdates {
            HStack(spacing: VSpacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text("Checking for updates...")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        } else if let result = updateCheckResult {
            switch result {
            case .upToDate:
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundStyle(VColor.systemPositiveStrong)
                    Text("You are on the latest version.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemPositiveStrong)
                }
            case .updateAvailable(let version):
                HStack(spacing: VSpacing.xs) {
                    VIconView(.info, size: 12)
                        .foregroundStyle(VColor.primaryBase)
                    Text("Version \(version) available")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.primaryBase)
                    Button(updateButtonLabel) {
                        if topology == .local {
                            AppDelegate.shared?.updateManager.checkForUpdates()
                            AppDelegate.shared?.aboutWindow?.close()
                        } else if AppDelegate.shared?.updateManager.isServiceGroupUpdateAvailable == true {
                            // Service group update — direct to Settings where the upgrade UI lives
                            AppDelegate.shared?.aboutWindow?.close()
                            AppDelegate.shared?.showSettingsTab("General")
                        } else {
                            // Client app update only — trigger Sparkle directly
                            AppDelegate.shared?.updateManager.checkForUpdates()
                            AppDelegate.shared?.aboutWindow?.close()
                        }
                    }
                    .buttonStyle(.plain)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.primaryBase)
                }
            case .notAvailable(let message):
                HStack(spacing: VSpacing.xs) {
                    VIconView(.info, size: 12)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(message)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            case .error:
                Text("Could not check for updates.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
    }

    // MARK: - Metadata Row (commit + architecture)

    @ViewBuilder
    private var metadataRow: some View {
        let archLabel: String = {
            #if arch(arm64)
            return "Apple Silicon"
            #elseif arch(x86_64)
            return "Intel"
            #else
            return "Unknown"
            #endif
        }()

        let commitSHA = Bundle.main.infoDictionary?["VellumCommitSHA"] as? String
        let hasCommit = commitSHA != nil && !commitSHA!.isEmpty

        HStack(spacing: VSpacing.xs) {
            if hasCommit {
                Text(String(commitSHA!.prefix(7)))
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .textSelection(.enabled)
                Text("\u{00B7}")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            Text(archLabel)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    // MARK: - Topology Label

    private func topologyLabel(_ topology: AssistantTopology) -> String {
        switch topology {
        case .docker: return "Docker"
        case .managed: return "Managed"
        case .local: return "Local"
        case .remote: return "Remote"
        }
    }

    // MARK: - Update Check

    private func performUpdateCheck() async {
        updateCheckResult = nil
        isCheckingForUpdates = true

        switch topology {
        case .local:
            // Local: trigger Sparkle and wait for delegate callback (up to 5s timeout)
            if let manager = AppDelegate.shared?.updateManager {
                let sparkleAvailable = await manager.checkForUpdatesAsync()
                if sparkleAvailable, let version = manager.availableUpdateVersion {
                    updateCheckResult = .updateAvailable(version: version)
                } else {
                    updateCheckResult = .upToDate
                }
            } else {
                updateCheckResult = .error
            }
            isCheckingForUpdates = false

        case .docker, .managed:
            defer { isCheckingForUpdates = false }

            // Check service group update
            await AppDelegate.shared?.updateManager.checkServiceGroupUpdate()
            let sgAvailable = AppDelegate.shared?.updateManager.isServiceGroupUpdateAvailable == true
            let sgVersion = AppDelegate.shared?.updateManager.serviceGroupUpdateVersion

            // Also check for client app updates
            let appUpdateAvailable: Bool
            if let manager = AppDelegate.shared?.updateManager {
                appUpdateAvailable = await manager.checkForUpdatesAsync()
            } else {
                appUpdateAvailable = false
            }

            if sgAvailable, let version = sgVersion {
                updateCheckResult = .updateAvailable(version: version)
            } else if appUpdateAvailable, let version = AppDelegate.shared?.updateManager.availableUpdateVersion {
                updateCheckResult = .updateAvailable(version: version)
            } else {
                updateCheckResult = .upToDate
            }

        case .remote:
            updateCheckResult = .notAvailable("Automatic updates are not available for remote deployments.")
            isCheckingForUpdates = false
        }
    }

    // MARK: - Fetch Healthz

    private func fetchHealthz() async {
        guard !selectedAssistantId.isEmpty else { return }
        do {
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            healthz = decoded ?? DaemonHealthz()
        } catch {
            healthz = DaemonHealthz()
        }
    }
}
