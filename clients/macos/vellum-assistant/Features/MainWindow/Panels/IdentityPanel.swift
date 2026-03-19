import SwiftUI
import VellumAssistantShared

struct IdentityPanel: View {
    let onClose: () -> Void
    let daemonClient: DaemonClient
    var identityClient: IdentityClientProtocol = IdentityClient()
    private let btwClient: any BtwClientProtocol = BtwClient()
    @State private var appearance = AvatarAppearanceManager.shared

    @State private var identity: IdentityInfo?
    @State private var remoteIdentity: RemoteIdentityInfo?
    @State private var metadata: AssistantMetadata?
    @State private var lockfileAssistant: LockfileAssistant?
    @State private var workspaceFiles: [WorkspaceFileNode] = []
    @State private var skills: [SkillInfo] = []
    @State private var viewingFilePath: String?
    @State private var showAvatarSheet: Bool = false
    @State private var introText: String? = nil
    @State private var introTask: Task<Void, Never>? = nil
    @State private var isIdentityMinimized: Bool = false

    /// Whether the BOOTSTRAP.md first-run ritual is still in progress.
    private var isBootstrapActive: Bool {
        let base = daemonClient.config.instanceDir ?? NSHomeDirectory()
        return FileManager.default.fileExists(atPath: base + "/.vellum/workspace/BOOTSTRAP.md")
    }

    private let panelPadding: CGFloat = VSpacing.xl

    private var assistantDisplayName: String {
        AssistantDisplayName.resolve(
            remoteIdentity?.name.nilIfEmpty,
            identity?.name,
            lockfileAssistant?.assistantId,
            fallback: "Unknown"
        )
    }

    var body: some View {
        GeometryReader { geo in
            let cardWidth: CGFloat = 260
            let cardHeight: CGFloat = geo.size.height * 0.25
            let avatarSize = min(80, cardHeight * 0.4)
            ZStack(alignment: .topLeading) {
                // Constellation fills entire panel
                ConstellationView(
                    identity: identity,
                    skills: skills,
                    workspaceFiles: workspaceFiles,
                    onFileSelected: { path in
                        viewingFilePath = path
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                // Compact identity overlay card / minimized avatar
                if isIdentityMinimized {
                    // Minimized: small circular avatar button
                    Button {
                        withAnimation(VAnimation.snappy) {
                            isIdentityMinimized = false
                        }
                    } label: {
                        VAvatarImage(image: appearance.fullAvatarImage, size: 36, showBorder: false)
                    }
                    .buttonStyle(.plain)
                    .frame(width: 44, height: 44)
                    .background(VColor.surfaceBase)
                    .clipShape(Circle())
                    .vShadow(VShadow.sm)
                    .padding(VSpacing.lg)
                    .transition(.scale(scale: 0.5, anchor: .topLeading).combined(with: .opacity))
                    .accessibilityLabel("Show identity card")
                } else {
                    // Full identity card
                    VStack(spacing: 0) {
                        // Intro heading
                        Text(introText ?? "I'm \(assistantDisplayName)!")
                            .font(.system(size: 22, weight: .regular, design: .rounded))
                            .foregroundColor(VColor.contentDefault)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, VSpacing.md)
                            .padding(.horizontal, VSpacing.sm)

                        Spacer().frame(minHeight: VSpacing.xs)

                        // Avatar
                        Group {
                            if let body = appearance.characterBodyShape,
                               let eyes = appearance.characterEyeStyle,
                               let color = appearance.characterColor {
                                AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color, size: avatarSize,
                                                   entryAnimationEnabled: true)
                                    .frame(width: avatarSize, height: avatarSize)
                                    .frame(maxWidth: .infinity, alignment: .center)
                            } else {
                                VAvatarImage(image: appearance.fullAvatarImage, size: avatarSize, showBorder: false)
                                    .frame(maxWidth: .infinity, alignment: .center)
                            }
                        }

                        Spacer().frame(minHeight: VSpacing.xs)

                        // Divider
                        Divider().background(VColor.surfaceOverlay)

                        // Role + Hatched date
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            let role = remoteIdentity?.role.nilIfEmpty ?? identity?.role
                            if let role, !role.isEmpty {
                                identityInfoRow(label: "Role", value: role)
                            }
                            if let date = metadata?.createdAt {
                                identityInfoRow(label: "Hatched", value: formatHatchedDate(date))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.sm)
                    }
                    .frame(width: cardWidth, height: cardHeight)
                    .background(VColor.surfaceBase)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .vShadow(VShadow.md)
                    .overlay(alignment: .topTrailing) {
                        VButton(label: "Minimize", iconOnly: VIcon.chevronUp.rawValue, style: .ghost) {
                            withAnimation(VAnimation.snappy) {
                                isIdentityMinimized = true
                            }
                        }
                        .padding(VSpacing.xs)
                    }
                    .padding(VSpacing.lg)
                    .transition(.scale(scale: 0.5, anchor: .topLeading).combined(with: .opacity))
                }
            }
            .animation(VAnimation.snappy, value: isIdentityMinimized)
            .overlay {
                VColor.auxBlack.opacity(viewingFilePath != nil ? 0.4 : 0)
                    .ignoresSafeArea()
                    .allowsHitTesting(viewingFilePath != nil)
                    .onTapGesture { viewingFilePath = nil }

                if let path = viewingFilePath {
                    WorkspaceFileSheet(filePath: path, onClose: { viewingFilePath = nil })
                        .frame(width: 600, height: 500)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                        .shadow(color: VColor.auxBlack.opacity(0.5), radius: 20, y: 8)
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                }
            }
            .animation(VAnimation.standard, value: viewingFilePath != nil)
            .overlay {
                VColor.auxBlack.opacity(showAvatarSheet ? 0.4 : 0)
                    .ignoresSafeArea()
                    .allowsHitTesting(showAvatarSheet)
                    .onTapGesture { showAvatarSheet = false }

                if showAvatarSheet {
                    AvatarManagementSheet(
                        onClose: { showAvatarSheet = false }
                    )
                    .frame(width: 360)
                    .fixedSize(horizontal: false, vertical: true)
                    .shadow(color: VColor.auxBlack.opacity(0.5), radius: 20, y: 8)
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
                }
            }
            .animation(VAnimation.standard, value: showAvatarSheet)
            .onAppear {
                identity = IdentityInfo.load()
                metadata = AssistantMetadata.load()
                lockfileAssistant = LockfileAssistant.loadLatest()
                workspaceFiles = WorkspaceFileNode.scan()
                fetchSkills()

                // For remote assistants without local IDENTITY.md, fetch from daemon
                if identity == nil, lockfileAssistant?.isRemote == true {
                    Task {
                        remoteIdentity = await identityClient.fetchRemoteIdentity()
                    }
                }

                if !isBootstrapActive && introText == nil {
                    // Prefer SOUL.md intro; fall back to daemon generation
                    if let soulIntro = IdentityInfo.loadIdentityIntro() {
                        introText = soulIntro
                    } else {
                        generateIntro()
                    }
                }
            }
            .onDisappear { introTask?.cancel() }
        }
    }

    // MARK: - Intro Generation

    private func generateIntro() {
        introTask?.cancel()

        introTask = Task {
            let key = "identity-intro"
            let prompt = "Generate a very short intro for yourself (2-5 words). This should feel natural to your personality — playful, formal, chill, whatever fits you. Some examples for inspiration (don't limit yourself to these): \"I'm [name]!\", \"It's [name]\", \"Hey, I'm [name]\", \"[name] here.\", \"[name], at your service.\" Output ONLY the intro text, nothing else."
            var result = ""
            do {
                let stream = btwClient.sendMessage(
                    content: prompt,
                    conversationKey: key
                )
                for try await delta in stream {
                    guard !Task.isCancelled else { return }
                    result += delta
                }
                let trimmed = result.trimmingCharacters(in: .whitespacesAndNewlines)
                self.introText = trimmed.isEmpty ? "I'm \(assistantDisplayName)!" : trimmed
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.introText = "I'm \(assistantDisplayName)!"
            }
        }
    }

    // MARK: - Skills

    private func fetchSkills() {
        Task {
            let response = await SkillsClient().fetchSkillsList()
            if let response {
                skills = response.skills.filter { $0.state == "enabled" }
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
            let name = AssistantDisplayName.firstUserFacing(from: [
                remoteIdentity?.name.nilIfEmpty,
                identity?.name,
                lockfileAssistant?.assistantId,
            ])
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
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)

            if truncate {
                Text(value)
                    .font(mono ? VFont.mono : VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(value)
            } else {
                Text(value)
                    .font(mono ? VFont.mono : VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)
            }
        }
    }

    private func identityInfoRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
            Text(value)
                .font(VFont.caption)
                .foregroundColor(VColor.contentEmphasized)
        }
    }

    private func formatHatchedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM yyyy"
        return formatter.string(from: date)
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
                VIconView(.fileText, size: 13)
                    .foregroundColor(VColor.systemNegativeHover)
                Text(fileName)
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                Button(action: onClose) {
                    VIconView(.x, size: 12)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.lg)

            Divider().background(VColor.borderBase)

            // Content
            ScrollView {
                MarkdownRenderer(text: fileContent)
                    .padding(VSpacing.xl)
            }
        }
        .background(VColor.surfaceBase)
        .task(id: filePath) {
            fileContent = (try? String(contentsOfFile: filePath, encoding: .utf8)) ?? "Unable to read file."
        }
    }
}
