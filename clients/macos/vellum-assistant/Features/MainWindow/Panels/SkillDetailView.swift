import SwiftUI
import VellumAssistantShared

/// Full-page detail view for an installed skill, showing metadata and a two-pane file browser.
struct SkillDetailView: View {
    let skill: SkillInfo
    @ObservedObject var skillsManager: SkillsManager
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
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            SkillDetailMetaInfo(skill: skill)
            skillDetailFileBrowser
        }
        .onAppear {
            skillsManager.fetchSkillFiles(skillId: skill.id)
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

    // MARK: - File Browser

    @ViewBuilder
    private var skillDetailFileBrowser: some View {
        HStack(alignment: .top, spacing: VSpacing.xl) {
            skillFilesSection
                .frame(width: 280, alignment: .topLeading)
                .frame(maxHeight: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(VColor.surfaceBase)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))

            skillDetailFileContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(VColor.surfaceBase)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var skillDetailFileContent: some View {
        if let selectedPath = expandedFilePath,
           let filesResponse = skillsManager.selectedSkillFiles,
           let file = filesResponse.files.first(where: { $0.path == selectedPath }),
           !file.isBinary,
           let content = file.content {
            FileContentView(
                fileName: file.path,
                mimeType: file.mimeType,
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

    @ViewBuilder
    private var skillFilesSection: some View {
        if skillsManager.isLoadingSkillFiles || skillsManager.skillFilesError != nil ||
            (skillsManager.selectedSkillFiles != nil && !skillsManager.selectedSkillFiles!.files.isEmpty) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Files")
                        .font(VFont.headline)
                        .foregroundColor(VColor.contentDefault)
                    Spacer()
                }
                .padding(.horizontal, VSpacing.md)
                .frame(height: 36)

                Divider().background(VColor.borderBase)

                VStack(spacing: 0) {
                    if skillsManager.isLoadingSkillFiles {
                        VStack {
                            Spacer()
                            ProgressView()
                                .frame(maxWidth: .infinity)
                            Spacer()
                        }
                    } else if let error = skillsManager.skillFilesError {
                        Text(error)
                            .font(VFont.caption)
                            .foregroundColor(VColor.systemNegativeStrong)
                            .padding(VSpacing.md)
                    } else if let filesResponse = skillsManager.selectedSkillFiles, !filesResponse.files.isEmpty {
                        ScrollView(.vertical) {
                            SkillFileTreeView(
                                files: filesResponse.files,
                                selectedFilePath: $expandedFilePath
                            )
                            .padding(.vertical, VSpacing.xs)
                        }
                    }
                }
                .frame(maxHeight: .infinity, alignment: .topLeading)
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
        HStack(spacing: VSpacing.sm) {
            VButton(
                label: "Back",
                iconOnly: VIcon.chevronLeft.rawValue,
                style: .ghost,
                tooltip: "Back to Skills"
            ) {
                onBack()
            }

            if let emoji = skill.emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: 16))
                    .frame(width: 20, height: 20)
            } else {
                VIconView(.zap, size: 12)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 20, height: 20)
            }

            Text(skill.name)
                .font(VFont.cardTitle)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(1)

            if skill.updateAvailable {
                Text("UPDATE")
                    .font(VFont.small)
                    .foregroundColor(VColor.systemNegativeHover)
            }

            Spacer()

            VSkillTypePill(source: skill.source)

            if skill.source == "managed" || skill.source == "clawhub" {
                VButton(
                    label: "Delete",
                    iconOnly: VIcon.trash.rawValue,
                    style: .dangerGhost,
                    tooltip: "Uninstall skill"
                ) {
                    onDelete()
                }
            }
        }
    }
}

// MARK: - Meta Info

struct SkillDetailMetaInfo: View {
    let skill: SkillInfo

    var body: some View {
        HStack(spacing: VSpacing.lg) {
            if let installedVersion = skill.installedVersion, !installedVersion.isEmpty {
                skillMetaItem(icon: .tag, value: "v\(installedVersion)")
            }

            if skill.updateAvailable {
                if let latestVersion = skill.latestVersion, !latestVersion.isEmpty {
                    skillMetaItem(icon: .circleArrowUp, value: "v\(latestVersion) available", color: VColor.systemNegativeHover)
                } else {
                    skillMetaItem(icon: .circleArrowUp, value: "Update available", color: VColor.systemNegativeHover)
                }
            }

            if let provenance = skill.provenance,
               provenance.kind == "third-party",
               let urlString = provenance.sourceUrl,
               let url = URL(string: urlString) {
                Link(destination: url) {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.externalLink, size: 9)
                        Text("View on \(provenance.provider ?? "source")")
                            .font(VFont.small)
                    }
                    .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func skillMetaItem(icon: VIcon, value: String, color: Color = VColor.contentTertiary) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 9)
            Text(value)
        }
        .font(VFont.small)
        .foregroundColor(color)
    }
}
