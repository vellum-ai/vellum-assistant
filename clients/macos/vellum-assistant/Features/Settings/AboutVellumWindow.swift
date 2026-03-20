import SwiftUI
import VellumAssistantShared

/// Custom About Vellum panel that replaces the native macOS About panel.
/// Shows the app icon, client version, service group version with topology
/// label, commit SHA, architecture, and a "Check for Updates..." button.
@MainActor
struct AboutVellumView: View {
    @State private var healthz: DaemonHealthz?
    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""

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

            Divider()

            // Service Group Version with topology label
            serviceGroupRow

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

            // Check for Updates button
            VButton(label: "Check for Updates...", style: .outlined) {
                AppDelegate.shared?.aboutWindow?.close()
                AppDelegate.shared?.showSettingsTab("General")
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

                if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) {
                    let topo: AssistantTopology = assistant.isDocker ? .docker
                        : assistant.isManaged ? .managed
                        : assistant.cloud.lowercased() == "local" ? .local
                        : .remote
                    Text("(\(topologyLabel(topo)))")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                if versionsMatch {
                    VIconView(.circleCheck, size: 14)
                        .foregroundColor(VColor.systemPositiveStrong)
                }
            } else {
                Text("Not connected")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
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
