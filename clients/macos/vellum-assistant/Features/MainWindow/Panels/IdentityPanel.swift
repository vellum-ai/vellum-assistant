import SwiftUI
import VellumAssistantShared

struct IdentityPanel: View {
    let onClose: () -> Void
    let onCustomizeAvatar: () -> Void
    let daemonClient: DaemonClient
    @State private var appearance = AvatarAppearanceManager.shared

    @State private var identity: IdentityInfo?
    @State private var remoteIdentity: RemoteIdentityInfo?
    @State private var metadata: AssistantMetadata?
    @State private var lockfileAssistant: LockfileAssistant?
    @State private var workspaceFiles: [WorkspaceFileNode] = []
    @State private var skills: [SkillInfo] = []
    @State private var viewingFilePath: String?
    @State private var isFullscreen: Bool = false

    private let sidebarWidth: CGFloat = 260

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // Left sidebar: title, avatar, ID card — hidden in fullscreen
            if !isFullscreen {
                VStack(alignment: .leading, spacing: 0) {
                    // Header — reduced top padding to align with close icon
                    Text("Identity")
                        .font(VFont.panelTitle)
                        .foregroundColor(VColor.textPrimary)
                        .padding(.top, VSpacing.lg)
                        .padding(.bottom, VSpacing.lg)

                    // Card wrapping avatar + ID fields + CTA
                    VStack(alignment: .leading, spacing: 0) {
                        // Compact avatar
                        DinoSceneView(seed: identity?.name ?? remoteIdentity?.name ?? lockfileAssistant?.assistantId ?? "default", palette: appearance.palette, outfit: appearance.outfit)
                            .frame(width: 120, height: 140)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, VSpacing.lg)

                        // ID card fields
                        idCardSection(identity: identity, remoteIdentity: remoteIdentity)
                            .padding(.top, VSpacing.lg)
                            .padding(.horizontal, VSpacing.lg)

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
                        .padding(.top, VSpacing.lg)
                        .padding(.horizontal, VSpacing.lg)
                        .padding(.bottom, VSpacing.lg)
                    }
                    .background(VColor.surface)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )

                    Spacer()
                }
                .frame(width: sidebarWidth)
                .padding(.horizontal, VSpacing.xl)
                .transition(.move(edge: .leading).combined(with: .opacity))
            }

            // Hex grid fills the rest of the space — full height, wrapped in a card
            ConstellationView(
                identity: identity,
                skills: skills,
                workspaceFiles: workspaceFiles,
                onFileSelected: { path in
                    viewingFilePath = path
                },
                isFullscreen: $isFullscreen
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.backgroundSubtle)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
            .padding(.top, VSpacing.lg)
            .padding(.trailing, VSpacing.xl)
            .padding(.bottom, VSpacing.xl)
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: isFullscreen)
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
            lockfileAssistant = LockfileAssistant.loadLatest()
            workspaceFiles = WorkspaceFileNode.scan()
            fetchSkills()

            // For remote assistants without local IDENTITY.md, fetch from daemon
            if identity == nil, lockfileAssistant?.isRemote == true {
                Task {
                    remoteIdentity = await daemonClient.fetchRemoteIdentity()
                }
            }
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
    private func idCardSection(identity: IdentityInfo?, remoteIdentity: RemoteIdentityInfo?) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Agent ID (only available from local identity)
            if let identity {
                idRow(label: "Agent ID", value: identity.agentID, mono: true)
            }

            // Given name: remote > local > assistantId
            let name = remoteIdentity?.name.nilIfEmpty ?? identity?.name ?? lockfileAssistant?.assistantId
            if let name {
                idRow(label: "Given name", value: name)
            }

            // Role: remote > local (truncated with tooltip for long values)
            let role = remoteIdentity?.role.nilIfEmpty ?? identity?.role
            if let role, !role.isEmpty {
                idRow(label: "Role", value: role, truncate: true)
            }

            // Personality: remote > local
            let personality = remoteIdentity?.personality.nilIfEmpty ?? identity?.personality
            if let personality, !personality.isEmpty {
                idRow(label: "Personality", value: personality)
            }

            // Version: remote > daemon > metadata
            let version = remoteIdentity?.version ?? daemonClient.daemonVersion ?? metadata?.version
            idRow(label: "Version", value: version ?? "—")

            if let date = metadata?.createdAt {
                idRow(label: "Created at", value: formatDate(date))
            }

            idRow(label: "Origin system", value: metadata?.originSystem ?? "local")
        }
    }

    private func idRow(label: String, value: String, mono: Bool = false, truncate: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 100, alignment: .leading)

            if truncate {
                Text(value)
                    .font(mono ? VFont.mono : VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(value)
            } else {
                Text(value)
                    .font(mono ? VFont.mono : VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .textSelection(.enabled)
            }

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

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
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
