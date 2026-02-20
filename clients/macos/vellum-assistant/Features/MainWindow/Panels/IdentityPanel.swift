import SwiftUI
import VellumAssistantShared

struct IdentityPanel: View {
    let onClose: () -> Void
    let onCustomizeAvatar: () -> Void
    let daemonClient: DaemonClient
    @State private var appearance = AvatarAppearanceManager.shared

    @State private var identity: IdentityInfo?
    @State private var metadata: AssistantMetadata?
    @State private var workspaceFiles: [WorkspaceFileNode] = []
    @State private var skills: [SkillInfo] = []
    @State private var viewingFilePath: String?

    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header + ID card area (max width matches other panels)
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack(alignment: .center) {
                    Text("Assistant ID")
                        .font(VFont.panelTitle)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                }
                .padding(.top, VSpacing.xxl)
                .padding(.bottom, VSpacing.xl)

                Divider().background(VColor.surfaceBorder)

                // Avatar + ID card + CTA
                HStack(alignment: .center, spacing: VSpacing.lg) {
                    DinoSceneView(seed: identity?.name ?? "default", palette: appearance.palette, outfit: appearance.outfit)
                        .frame(width: 180, height: 200)

                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        if let identity {
                            idCardSection(identity: identity)
                        }

                        // Customize Avatar CTA
                        Button(action: onCustomizeAvatar) {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: "paintpalette")
                                    .font(.system(size: 12, weight: .medium))
                                Text("Customize Avatar")
                                    .font(VFont.bodyMedium)
                            }
                            .foregroundColor(VColor.accent)
                            .padding(.horizontal, VSpacing.lg)
                            .padding(.vertical, VSpacing.sm)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .stroke(VColor.accent.opacity(0.3), lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, VSpacing.xl)
            }
            .frame(maxWidth: maxContentWidth)
            .padding(.horizontal, VSpacing.xxl)
            .frame(maxWidth: .infinity)

            // Constellation fills remaining space (pan + zoom to navigate)
            ConstellationView(
                identity: identity,
                skills: skills,
                workspaceFiles: workspaceFiles,
                onFileSelected: { path in
                    viewingFilePath = path
                }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.background)
        }
        .background(VColor.backgroundSubtle)
        .overlay {
            if let path = viewingFilePath {
                // Dismiss backdrop
                Color.black.opacity(0.4)
                    .ignoresSafeArea()
                    .onTapGesture { viewingFilePath = nil }

                WorkspaceFileSheet(filePath: path, onClose: { viewingFilePath = nil })
                    .frame(width: 600, height: 500)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                    .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
            }
        }
        .animation(VAnimation.standard, value: viewingFilePath != nil)
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

            if !identity.personality.isEmpty {
                idRow(label: "Personality", value: identity.personality)
            }

            idRow(label: "Version", value: daemonClient.daemonVersion ?? metadata?.version ?? "—")

            if let date = metadata?.createdAt {
                idRow(label: "Created at", value: formatDate(date))
            }

            idRow(label: "Origin system", value: metadata?.originSystem ?? "local")

            if let home = identity.home {
                homeRow(home: home)
            }
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

// MARK: - Workspace File Sheet

private struct WorkspaceFileSheet: View {
    let filePath: String
    let onClose: () -> Void

    @State private var fileContent: String = ""

    private var fileName: String {
        (filePath as NSString).lastPathComponent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Image(systemName: "doc.text.fill")
                    .font(.system(size: 13))
                    .foregroundColor(Amber._400)
                Text(fileName)
                    .font(VFont.cardTitle)
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
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.lg)

            Divider().background(VColor.surfaceBorder)

            // Content
            ScrollView {
                MarkdownRenderer(text: fileContent)
                    .padding(VSpacing.xl)
            }
        }
        .background(VColor.backgroundSubtle)
        .task(id: filePath) {
            fileContent = (try? String(contentsOfFile: filePath, encoding: .utf8)) ?? "Unable to read file."
        }
    }
}
