import SwiftUI
import VellumAssistantShared

struct IdentityPanel: View {
    let onClose: () -> Void
    let daemonClient: DaemonClient

    @State private var identity: IdentityInfo?
    @State private var metadata: AssistantMetadata?
    @State private var workspaceFiles: [WorkspaceFileNode] = []
    @State private var skills: [SkillInfo] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text("Assistant ID")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close Assistant ID")
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)

            Divider()
                .background(VColor.surfaceBorder)

            ScrollView {
                VStack(spacing: VSpacing.xl) {
                    // Avatar + ID card side by side
                    HStack(alignment: .center, spacing: VSpacing.lg) {
                        DinoSceneView(seed: identity?.name ?? "default")
                            .frame(width: 180, height: 200)

                        if let identity {
                            idCardSection(identity: identity)
                        }
                    }
                    .padding(.horizontal, VSpacing.lg)

                    Divider()
                        .background(VColor.surfaceBorder)
                        .padding(.horizontal, VSpacing.lg)

                    // Constellation
                    ConstellationView(
                        identity: identity,
                        skills: skills,
                        workspaceFiles: workspaceFiles
                    )
                    .frame(height: 400)
                }
                .padding(.vertical, VSpacing.lg)
            }
        }
        .background(VColor.backgroundSubtle)
        .onAppear {
            identity = IdentityInfo.load()
            metadata = AssistantMetadata.load()
            workspaceFiles = WorkspaceFileNode.scan()
            fetchSkills()
        }
    }

    // MARK: - Skills

    private func fetchSkills() {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(SkillsListRequestMessage())
            } catch {
                return
            }

            for await message in stream {
                if case .skillsListResponse(let response) = message {
                    skills = response.skills.filter { $0.state == "enabled" }
                    return
                }
            }
        }
    }

    // MARK: - ID Card

    @ViewBuilder
    private func idCardSection(identity: IdentityInfo) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            idRow(label: "Agent ID", value: identity.agentID, mono: true)
            idRow(label: "Given name", value: identity.name)

            if !identity.role.isEmpty {
                idRow(label: "Role", value: identity.role)
            }

            if !identity.vibe.isEmpty {
                idRow(label: "Vibe", value: identity.vibe)
            }

            idRow(label: "Version", value: metadata?.version ?? "v1.0")

            if let date = metadata?.createdAt {
                idRow(label: "Created at", value: formatDate(date))
            }

            idRow(label: "Origin system", value: metadata?.originSystem ?? "local")
        }
    }

    private func idRow(label: String, value: String, mono: Bool = false) -> some View {
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

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
