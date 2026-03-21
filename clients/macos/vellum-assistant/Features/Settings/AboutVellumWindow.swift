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

    /// Whether the client and service group versions match.
    private var versionsMatch: Bool {
        guard let sgVersion = healthz?.version, !sgVersion.isEmpty,
              let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let sgParsed = VersionCompat.parse(sgVersion),
              let appParsed = VersionCompat.parse(appVersion) else {
            return false
        }
        return sgParsed.major == appParsed.major
            && sgParsed.minor == appParsed.minor
            && sgParsed.patch == appParsed.patch
    }

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            // App Icon
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 80, height: 80)

            // App Name
            Text("Vellum")
                .font(VFont.title)
                .foregroundColor(VColor.contentEmphasized)

            // Client Version
            if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
                Text("Version \(version)" + (build.map { " (\($0))" } ?? ""))
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
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

            // Debug build info
            #if DEBUG
            VStack(spacing: VSpacing.xs) {
                Text("Local Development Build")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.systemMidStrong)
                Text(Bundle.main.bundlePath)
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            #endif

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
            lockfileAssistants = LockfileAssistant.loadAll()
            selectedAssistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
            Task { await fetchHealthz() }
        }
    }

    // MARK: - Service Group Row

    @ViewBuilder
    private var serviceGroupRow: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Service Group")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)

            if let version = healthz?.version, !version.isEmpty {
                Text(version)
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)

                Text("(\(topologyLabel(topology)))")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)

                if versionsMatch {
                    VIconView(.circleCheck, size: 14)
                        .foregroundColor(VColor.systemPositiveStrong)
                }
            } else {
                Text("Not connected")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
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
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        } else if let result = updateCheckResult {
            switch result {
            case .upToDate:
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundColor(VColor.systemPositiveStrong)
                    Text("You are on the latest version.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemPositiveStrong)
                }
            case .updateAvailable(let version):
                VStack(spacing: VSpacing.sm) {
                    HStack(spacing: VSpacing.xs) {
                        Text("Update available:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Text(version)
                            .font(VFont.mono)
                            .foregroundColor(VColor.primaryBase)
                    }
                    VButton(label: "Update in Settings", style: .outlined) {
                        AppDelegate.shared?.aboutWindow?.close()
                        AppDelegate.shared?.showSettingsTab("General")
                    }
                }
            case .notAvailable(let message):
                HStack(spacing: VSpacing.xs) {
                    VIconView(.info, size: 12)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(message)
                        .font(VFont.caption)
                        .foregroundStyle(VColor.contentTertiary)
                }
            case .error:
                Text("Could not check for updates.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
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
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentTertiary)
                    .textSelection(.enabled)
                Text("\u{00B7}")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
            Text(archLabel)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
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
            // Docker/managed: check platform API and show result inline
            defer { isCheckingForUpdates = false }

            await AppDelegate.shared?.updateManager.checkServiceGroupUpdate()

            if let updateManager = AppDelegate.shared?.updateManager {
                if updateManager.isServiceGroupUpdateAvailable,
                   let version = updateManager.serviceGroupUpdateVersion {
                    updateCheckResult = .updateAvailable(version: version)
                } else {
                    updateCheckResult = .upToDate
                }
            } else {
                updateCheckResult = .error
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
                path: "assistants/\(selectedAssistantId)/healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            healthz = decoded ?? DaemonHealthz()
        } catch {
            healthz = DaemonHealthz()
        }
    }
}
