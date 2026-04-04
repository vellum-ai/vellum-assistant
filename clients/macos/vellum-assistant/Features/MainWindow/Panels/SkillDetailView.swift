import SwiftUI
import VellumAssistantShared

/// Full-page detail view for an installed skill, showing metadata and a two-pane file browser.
struct SkillDetailView: View {
    let skill: SkillInfo
    var skillsManager: SkillsManager
    let onBack: () -> Void
    let onDelete: (SkillInfo) -> Void

    @State private var expandedFilePath: String?
    @State private var skillFileViewMode: FileViewMode = .source

    private var hasViewableFiles: Bool {
        guard let files = skillsManager.selectedSkillFiles else { return true }
        return files.files.contains { !$0.isBinary && $0.content != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            SkillDetailTitleRow(
                skill: skill,
                onBack: onBack,
                onDelete: { onDelete(skill) }
            )

            if !skill.description.isEmpty {
                Text(skill.description)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(8)
                    .frame(maxWidth: 800, alignment: .leading)
            }
            originMetaRow
            skillDetailFileBrowser
        }
        .onAppear {
            // Only fetch files for locally available skills (bundled or installed).
            // Remote catalog search results are not in the local resolved catalog, so
            // GET /skills/:id/files would 404 for them.
            if skill.isInstalled {
                skillsManager.fetchSkillFiles(skillId: skill.id)
            }
        }
        .onChange(of: skillsManager.selectedSkillFiles?.files.map(\.path)) {
            if expandedFilePath == nil, let files = skillsManager.selectedSkillFiles?.files {
                let skillMd = files.first { $0.path == "SKILL.md" && !$0.isBinary && $0.content != nil }
                let firstText = files.first { !$0.isBinary && $0.content != nil }
                if let selectedFile = skillMd ?? firstText {
                    expandedFilePath = selectedFile.path
                    let autoModes = availableViewModes(for: selectedFile.path, mimeType: selectedFile.mimeType)
                    skillFileViewMode = autoModes.first ?? .source
                }
            }
        }
        .onChange(of: expandedFilePath) {
            if let selectedPath = expandedFilePath,
               let filesResponse = skillsManager.selectedSkillFiles,
               let file = filesResponse.files.first(where: { $0.path == selectedPath }) {
                let selectedModes = availableViewModes(for: file.path, mimeType: file.mimeType)
                skillFileViewMode = selectedModes.first ?? .source
            }
        }
        .onDisappear {
            expandedFilePath = nil
            skillsManager.clearSkillDetail()
        }
    }

    // MARK: - Origin-Specific Metadata

    @ViewBuilder
    private var originMetaRow: some View {
        switch skill.originMeta {
        case .clawhub(let meta):
            HStack(spacing: VSpacing.lg) {
                if !meta.author.isEmpty {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.user, size: 12)
                        Text(meta.author)
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
                if meta.stars > 0 {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.star, size: 12)
                        Text("\(meta.stars)")
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
                if meta.installs > 0 {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.arrowDownToLine, size: 12)
                        Text("\(meta.installs)")
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
            }
        case .skillssh(let meta):
            HStack(spacing: VSpacing.lg) {
                if !meta.sourceRepo.isEmpty {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.gitBranch, size: 12)
                        Text(meta.sourceRepo)
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
                if meta.installs > 0 {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.arrowDownToLine, size: 12)
                        Text("\(meta.installs)")
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
            }
        case .vellum, .custom:
            EmptyView()
        }
    }

    // MARK: - File Browser

    private var browserFiles: [VFileBrowserFile] {
        guard let files = skillsManager.selectedSkillFiles else { return [] }
        return files.files
            .filter { !$0.isBinary && $0.content != nil }
            .map { VFileBrowserFile(
                id: $0.path, name: $0.name, path: $0.path,
                size: $0.size, mimeType: $0.mimeType,
                isBinary: $0.isBinary, content: $0.content,
                icon: fileIcon(for: $0.mimeType, fileName: $0.name)
            )}
    }

    @ViewBuilder
    private var skillDetailFileBrowser: some View {
        if skillsManager.isLoadingSkillFiles {
            VEmptyState(
                title: "Loading files...",
                icon: VIcon.fileText.rawValue
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay { ProgressView().controlSize(.small) }
        } else if let error = skillsManager.skillFilesError {
            VEmptyState(
                title: "Failed to load files",
                subtitle: error,
                icon: VIcon.circleAlert.rawValue
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VFileBrowser(
                files: browserFiles,
                selectedPath: $expandedFilePath
            ) { selectedFile in
                if let selectedFile,
                   let content = selectedFile.content {
                    FileContentView(
                        fileName: selectedFile.path,
                        mimeType: selectedFile.mimeType,
                        content: .constant(content),
                        viewMode: $skillFileViewMode,
                        isActivelyEditing: .constant(false)
                    )
                } else {
                    VEmptyState(
                        title: hasViewableFiles ? "Select a file to view" : "No viewable files",
                        icon: VIcon.fileText.rawValue
                    )
                }
            }
        }
    }
}

// MARK: - Title Row

struct SkillDetailTitleRow: View {
    let skill: SkillInfo
    let onBack: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack {
            HStack(spacing: VSpacing.lg) {
                VButton(
                    label: "Back",
                    iconOnly: VIcon.arrowLeft.rawValue,
                    style: .outlined,
                    tooltip: "Back to Skills"
                ) {
                    onBack()
                }
                .frame(width: 32, height: 32)

                HStack(spacing: VSpacing.sm) {
                    if let emoji = skill.emoji, !emoji.isEmpty {
                        Text(emoji)
                            .font(.system(size: 20))
                    }

                    Text(skill.name)
                        .font(VFont.titleMedium)
                        .foregroundStyle(VColor.contentEmphasized)
                        .lineLimit(1)
                }

            }

            Spacer()

            VSkillTypePill(origin: skill.origin)

            if skill.kind == "installed" {
                VButton(label: "Remove", leftIcon: VIcon.trash.rawValue, style: .dangerOutline) {
                    onDelete()
                }
            }
        }
    }
}

