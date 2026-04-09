import SwiftUI
import VellumAssistantShared

struct IdentityPanel: View {
    let onClose: () -> Void
    let connectionManager: GatewayConnectionManager
    var onNavigateToSkill: ((String) -> Void)?
    var onNavigateToFile: ((String) -> Void)?
    var onOpenThread: ((String) -> Void)?
    private let btwClient: any BtwClientProtocol = BtwClient()
    var workspaceClient: WorkspaceClientProtocol = WorkspaceClient()
    @State private var appearance = AvatarAppearanceManager.shared

    @State private var identity: IdentityInfo?
    @State private var metadata: AssistantMetadata?
    @State private var lockfileAssistant: LockfileAssistant?
    @State private var workspaceFiles: [WorkspaceFileNode] = []
    @State private var skills: [SkillInfo] = []
    @State private var skillCategoryLookup: [String: SkillCategory] = [:]
    @State private var viewingFilePath: String?
    @State private var isFullscreen: Bool = false
    @State private var showAvatarSheet: Bool = false
    @State private var introText: String? = nil
    @State private var introTask: Task<Void, Never>? = nil
    @State private var bootstrapCheckTask: Task<Void, Never>? = nil
    @State private var skillsTask: Task<Void, Never>? = nil
    @State private var isBootstrapActive: Bool = true
    @State private var isEditingName: Bool = false
    @State private var editingNameText: String = ""
    @State private var isSavingIdentityField: Bool = false

    private let sidebarMinWidth: CGFloat = 200
    private let sidebarMaxWidth: CGFloat = 280
    private let sidebarFraction: CGFloat = 0.3

    private let panelPadding: CGFloat = VSpacing.xl

    private var assistantDisplayName: String {
        AssistantDisplayName.resolve(
            identity?.name,
            fallback: "Your Assistant"
        )
    }

    private var hasRealName: Bool {
        AssistantDisplayName.firstUserFacing(from: [
            identity?.name
        ]) != nil
    }

    var body: some View {
        GeometryReader { geo in
            let computedSidebarWidth = min(sidebarMaxWidth, max(sidebarMinWidth, geo.size.width * sidebarFraction))
            let avatarSize = min(180, computedSidebarWidth - VSpacing.lg * 2)
            HStack(alignment: .top, spacing: 0) {
                // Left sidebar: title, avatar, ID card — hidden in fullscreen
                if !isFullscreen {
                    VStack(spacing: 0) {
                        VStack(spacing: 0) {
                            // Intro heading — show daemon-generated text, fall back to static name
                            Text(introText ?? (hasRealName ? "I'm \(assistantDisplayName)!" : assistantDisplayName))
                                .font(VFont.titleMedium)
                                .foregroundStyle(VColor.contentDefault)
                                .multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .overlay(alignment: .trailing) {
                                    Button {
                                        onOpenThread?("I want to change your name")
                                    } label: {
                                        VIconView(.pencil, size: 13)
                                            .foregroundStyle(VColor.contentTertiary)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Edit Name")
                                    .help("Edit Name")
                                    .offset(x: VSpacing.xl)
                                }
                                .padding(.top, VSpacing.xxl)
                                .padding(.horizontal, VSpacing.lg)

                            Spacer()

                            // Large centered avatar
                            Group {
                                if appearance.customAvatarImage != nil {
                                    VAvatarImage(image: appearance.fullAvatarImage, size: avatarSize, showBorder: false)
                                        .frame(maxWidth: .infinity, alignment: .center)
                                } else if let body = appearance.characterBodyShape,
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

                            // Update Avatar button
                            VButton(label: "Update Avatar", style: .outlined) { showAvatarSheet = true }
                                .padding(.top, VSpacing.xxl)

                            Spacer()

                            // Divider
                            Rectangle().fill(VColor.surfaceOverlay).frame(height: 2)

                            // Role + Hatched date
                            VStack(alignment: .leading, spacing: VSpacing.lg) {
                                let role = AssistantDisplayName.firstUserFacing(from: [
                                    identity?.role
                                ])
                                editableInfoRow(label: "Role", value: role ?? "Not set") {
                                    onOpenThread?("I want to change your role description")
                                }
                                if let date = metadata?.createdAt {
                                    identityInfoRow(label: "Hatched", value: formatHatchedDate(date))
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, VSpacing.lg)
                            .padding(.vertical, VSpacing.lg)
                        }
                        .frame(maxHeight: .infinity)
                        .background(VColor.surfaceBase)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    }
                    .frame(width: computedSidebarWidth)
                    .padding(.trailing, VSpacing.lg)
                    .transition(.move(edge: .leading).combined(with: .opacity))
                }

            // Hex grid fills the rest of the space — card when not fullscreen
            ConstellationView(
                identity: identity,
                skills: skills,
                workspaceFiles: workspaceFiles,
                categoryLookup: skillCategoryLookup,
                onNavigateToSkill: onNavigateToSkill,
                onNavigateToFile: onNavigateToFile,
                isFullscreen: $isFullscreen
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(isFullscreen ? Color.clear : VColor.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: isFullscreen ? 0 : VRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: isFullscreen ? 0 : VRadius.lg)
                    .stroke(isFullscreen ? Color.clear : VColor.borderDisabled, lineWidth: 1)
            )
                .padding(.trailing, 0)
            }
            .animation(.spring(response: 0.4, dampingFraction: 0.8), value: isFullscreen)
            .sheet(isPresented: Binding(
                get: { viewingFilePath != nil },
                set: { if !$0 { viewingFilePath = nil } }
            )) {
                if let path = viewingFilePath {
                    WorkspaceFileSheet(filePath: path, onClose: { viewingFilePath = nil })
                        .frame(width: 600, height: 500)
                }
            }
            .sheet(isPresented: $showAvatarSheet) {
                AvatarManagementSheet(
                    onClose: { showAvatarSheet = false }
                )
                .frame(width: 360)
                .fixedSize(horizontal: false, vertical: true)
            }
            .task {
                // Load identity, lockfile, and workspace files in parallel.
                // Previously these ran sequentially — if the gateway was slow
                // to respond on startup the view appeared frozen because nothing
                // populated until the first network call (up to 10 s timeout)
                // completed. Using `async let` reduces total wait from the sum
                // of all calls to the maximum of the three.
                // `LockfileAssistant.loadLatest()` is synchronous file I/O, so
                // it runs inside `Task.detached` to keep it off the main actor
                // (matches the pattern in SettingsDeveloperTab, AboutVellumWindow,
                // and SettingsGeneralTab).
                async let identityResult = IdentityInfo.loadWithMetadata()
                async let lockfileResult = Task.detached { LockfileAssistant.loadLatest() }.value
                async let workspaceResult = WorkspaceFileNode.scanAsync()

                let (idResult, lockfile, files) = await (identityResult, lockfileResult, workspaceResult)

                identity = idResult.identity
                metadata = idResult.metadata
                lockfileAssistant = lockfile
                workspaceFiles = files

                // Fetch skills after workspace files are ready so the
                // ConstellationView layout triggered by skills.count change
                // includes both data sets.
                fetchSkills()

                bootstrapCheckTask = Task {
                    let fileResponse = await workspaceClient.fetchWorkspaceFile(path: "BOOTSTRAP.md", showHidden: false)
                    guard !Task.isCancelled else { return }
                    isBootstrapActive = fileResponse != nil

                    if !isBootstrapActive && introText == nil {
                        if let soulIntro = await IdentityInfo.loadIdentityIntroAsync() {
                            introText = soulIntro
                        } else {
                            generateIntro()
                        }
                    }
                }
            }
            .onDisappear { bootstrapCheckTask?.cancel(); introTask?.cancel(); skillsTask?.cancel() }
        }
    }

    // MARK: - Inline Editing

    @ViewBuilder
    private func inlineEditField(
        text: Binding<String>,
        placeholder: String,
        font: Font,
        isSaving: Bool,
        onSave: @escaping () -> Void,
        onCancel: @escaping () -> Void
    ) -> some View {
        HStack(spacing: VSpacing.xs) {
            TextField(placeholder, text: text)
                .font(font)
                .foregroundStyle(VColor.contentDefault)
                .textFieldStyle(.plain)
                .onSubmit { onSave() }

            if isSaving {
                ProgressView()
                    .controlSize(.small)
            } else {
                VButton(label: "Save", iconOnly: VIcon.check.rawValue, style: .ghost, size: .compact) {
                    onSave()
                }
                VButton(label: "Cancel", iconOnly: VIcon.x.rawValue, style: .ghost, size: .compact) {
                    onCancel()
                }
            }
        }
    }

    /// Save a field in IDENTITY.md (e.g. "Name", "Role") via the workspace API.
    private func saveIdentityField(field: String, value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSavingIdentityField else { return }
        isSavingIdentityField = true

        Task {
            defer { isSavingIdentityField = false }

            let fileResponse = await workspaceClient.fetchWorkspaceFile(path: "IDENTITY.md", showHidden: false)
            guard let content = fileResponse?.content else {
                isEditingName = false
                return
            }

            let key = "- **\(field.lowercased()):**"
            let lines = content.components(separatedBy: "\n")
            let updatedLines = lines.map { line -> String in
                if line.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix(key) {
                    return "- **\(field):** \(trimmed)"
                }
                return line
            }
            let updatedContent = updatedLines.joined(separator: "\n")

            let success = await workspaceClient.writeWorkspaceFile(
                path: "IDENTITY.md",
                content: updatedContent.data(using: .utf8) ?? Data()
            )

            if success {
                identity = await IdentityInfo.loadAsync()
                isEditingName = false

                if field == "Name" {
                    introText = nil
                    if !isBootstrapActive {
                        if let soulIntro = await IdentityInfo.loadIdentityIntroAsync() {
                            introText = soulIntro
                        } else {
                            generateIntro()
                        }
                    }
                }
            } else {
                isEditingName = false
            }
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
                self.introText = trimmed.isEmpty ? (hasRealName ? "I'm \(assistantDisplayName)!" : "I need a name!") : trimmed
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.introText = hasRealName ? "I'm \(assistantDisplayName)!" : "I need a name!"
            }
        }
    }

    // MARK: - Skills

    private func fetchSkills() {
        skillsTask?.cancel()
        skillsTask = Task {
            let response = await SkillsClient().fetchSkillsList(includeCatalog: false)
            guard !Task.isCancelled else { return }
            if let response {
                let enabled = response.skills.filter { $0.status == "enabled" }
                let map = await Task.detached {
                    var m: [String: SkillCategory] = [:]
                    m.reserveCapacity(enabled.count)
                    for skill in enabled {
                        m[skill.id] = inferCategory(skill)
                    }
                    return m
                }.value
                guard !Task.isCancelled else { return }
                skills = enabled
                skillCategoryLookup = map
            }
        }
    }

    // MARK: - ID Card

    @ViewBuilder
    private func idCardSection(identity: IdentityInfo?) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Agent ID
            if let identity {
                idRow(label: "Agent ID", value: identity.agentID, mono: true)
            }

            // Given name
            let name = AssistantDisplayName.firstUserFacing(from: [
                identity?.name,
                lockfileAssistant?.assistantId,
            ])
            if let name {
                idRow(label: "Given name", value: name)
            }

            // Role (truncated with tooltip for long values)
            if let role = identity?.role, !role.isEmpty {
                idRow(label: "Role", value: role, truncate: true)
            }

            // Personality
            if let personality = identity?.personality, !personality.isEmpty {
                idRow(label: "Personality", value: personality)
            }

            // Version
            let version = connectionManager.assistantVersion ?? metadata?.version
            idRow(label: "Version", value: version ?? "—")

            if let date = metadata?.createdAt {
                idRow(label: "Created at", value: formatDate(date))
            }

            idRow(label: "Origin system", value: lockfileAssistant?.cloud ?? "local")
        }
    }

    private func idRow(label: String, value: String, mono: Bool = false, truncate: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

            if truncate {
                Text(value)
                    .font(mono ? VFont.bodyMediumDefault : VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(value)
            } else {
                Text(value)
                    .font(mono ? VFont.bodyMediumDefault : VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
            }
        }
    }

    private func editableInfoRow(label: String, value: String, onEdit: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            HStack(spacing: VSpacing.xs) {
                Text(label)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
                Spacer()
                Button(action: onEdit) {
                    VIconView(.pencil, size: 10)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Edit \(label)")
                .help("Edit \(label)")
            }
            Text(value)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(2)
                .truncationMode(.tail)
        }
    }

    private func identityInfoRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
            Text(value)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
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
                    .foregroundStyle(VColor.systemNegativeHover)
                Text(fileName)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                Button(action: onClose) {
                    VIconView(.x, size: 12)
                        .foregroundStyle(VColor.contentTertiary)
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
                    .equatable()
                    .padding(VSpacing.xl)
            }
        }
        .background(VColor.surfaceBase)
        .task(id: filePath) {
            if let response = await WorkspaceClient().fetchWorkspaceFile(path: filePath, showHidden: false),
               let content = response.content {
                fileContent = content
            } else {
                fileContent = "Unable to read file."
            }
        }
    }
}
