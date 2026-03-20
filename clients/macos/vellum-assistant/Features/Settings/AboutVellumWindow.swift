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

            // Commit SHA
            if let commitSHA = Bundle.main.infoDictionary?["VellumCommitSHA"] as? String, !commitSHA.isEmpty {
                HStack(spacing: VSpacing.xs) {
                    Text("Commit")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Text(String(commitSHA.prefix(7)))
                        .font(VFont.mono)
                        .foregroundColor(VColor.contentSecondary)
                        .textSelection(.enabled)
                }
            }

            // Architecture
            architectureLabel

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

            Spacer()
                .frame(height: VSpacing.sm)

            // Check for Updates button
            VButton(label: "Check for Updates...", style: .outlined) {
                AppDelegate.shared?.aboutWindow?.close()
                AppDelegate.shared?.showSettingsTab("General")
            }
        }
        .frame(width: 320)
        .padding(VSpacing.xxl)
        .multilineTextAlignment(.center)
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
            } else {
                Text("Not connected")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Architecture Label

    private var architectureLabel: some View {
        let label: String = {
            #if arch(arm64)
            return "Apple Silicon"
            #elseif arch(x86_64)
            return "Intel"
            #else
            return "Unknown architecture"
            #endif
        }()
        return Text(label)
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)
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
