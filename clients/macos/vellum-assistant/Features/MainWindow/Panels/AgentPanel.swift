import SwiftUI
import VellumAssistantShared

// MARK: - Agent Panel Content (embeddable)

/// The installed skills management content, usable standalone
/// (e.g. inside IntelligencePanel).
struct AgentPanelContent: View {
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onSkillsChanged: (() -> Void)?
    let daemonClient: DaemonClient

    @StateObject private var skillsManager: SkillsManager
    @State private var selectedInstalledSkillId: String?
    @State private var skillToDelete: SkillInfo?
    @State private var selectedCategory: SkillCategory?
    @State private var globalSkillSearchQuery = ""
    @State private var expandedFilePath: String?

    init(onInvokeSkill: ((SkillInfo) -> Void)? = nil, onSkillsChanged: (() -> Void)? = nil, daemonClient: DaemonClient) {
        self.onInvokeSkill = onInvokeSkill
        self.onSkillsChanged = onSkillsChanged
        self.daemonClient = daemonClient
        _skillsManager = StateObject(wrappedValue: SkillsManager(daemonClient: daemonClient))
    }

    private var normalizedSkillQuery: String {
        globalSkillSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Whether any files in the selected skill are viewable (non-binary with content).
    private var hasViewableFiles: Bool {
        skillsManager.selectedSkillFiles?.files.contains { !$0.isBinary && $0.content != nil } ?? false
    }

    private var hasActiveSearch: Bool { !normalizedSkillQuery.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            skillsContent
        }
        .onAppear {
            skillsManager.fetchSkills()
        }
        .onChange(of: skillsManager.skills.map(\.id)) {
            onSkillsChanged?()
            if let selectedId = selectedInstalledSkillId,
               !skillsManager.skills.contains(where: { $0.id == selectedId }) {
                selectedInstalledSkillId = nil
            }
        }
        .onChange(of: globalSkillSearchQuery) {
            // Clear stale selections when search filters them out
            if let selectedId = selectedInstalledSkillId,
               !filteredUserSkills.contains(where: { $0.id == selectedId }) {
                selectedInstalledSkillId = nil
            }
        }
        .sheet(item: $skillToDelete) { skill in
            SkillDeleteConfirmView(
                skillName: skill.name,
                onDelete: {
                    skillsManager.uninstallSkill(id: skill.id)
                    skillToDelete = nil
                },
                onCancel: {
                    skillToDelete = nil
                }
            )
        }
    }

    // MARK: - Skills Tab

    /// Skills to show in the Skills tab.
    private var userSkills: [SkillInfo] {
        skillsManager.skills
    }

    /// Installed skills filtered by the global search query.
    private var filteredUserSkills: [SkillInfo] {
        guard hasActiveSearch else { return userSkills }
        let query = normalizedSkillQuery
        return userSkills.filter {
            $0.name.lowercased().contains(query) ||
            $0.description.lowercased().contains(query) ||
            $0.id.lowercased().contains(query) ||
            sourceLabel($0.source).lowercased().contains(query)
        }
    }

    /// Installed skills further filtered by the selected category.
    private var categoryFilteredSkills: [SkillInfo] {
        guard let category = selectedCategory else { return filteredUserSkills }
        return filteredUserSkills.filter { inferCategory($0) == category }
    }

    /// Count of installed skills per category (based on search-filtered list).
    private func skillCount(for category: SkillCategory) -> Int {
        filteredUserSkills.filter { inferCategory($0) == category }.count
    }

    // MARK: - Category Sidebar

    @ViewBuilder
    private var categorySidebar: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            SidebarPrimaryRow(
                icon: VIcon.layoutGrid.rawValue,
                label: "All",
                isActive: selectedCategory == nil
            ) {
                withAnimation(VAnimation.fast) { selectedCategory = nil }
            }

            ForEach(SkillCategory.allCases, id: \.rawValue) { category in
                SidebarPrimaryRow(
                    icon: category.icon.rawValue,
                    label: category.displayName,
                    isActive: selectedCategory == category
                ) {
                    withAnimation(VAnimation.fast) { selectedCategory = category }
                }
            }

            Spacer()
        }
        .frame(width: 180)
    }

    // MARK: - Skills Content

    @ViewBuilder
    private var skillsContent: some View {
        if let selectedId = selectedInstalledSkillId,
           let skill = filteredUserSkills.first(where: { $0.id == selectedId }) {
            installedSkillDetailView(skill)
        } else if skillsManager.isLoading {
            HStack {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Spacer()
            }
            .frame(height: 60)
        } else if filteredUserSkills.isEmpty {
            if hasActiveSearch {
                VStack(spacing: VSpacing.md) {
                    VEmptyState(
                        title: "No matches",
                        subtitle: "No installed skills matched \"\(globalSkillSearchQuery)\"",
                        icon: VIcon.search.rawValue
                    )
                }
                .frame(minHeight: 100)
            } else {
                VStack(spacing: VSpacing.md) {
                    Text("No skills installed")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Button(action: { skillsManager.fetchSkills() }) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.refreshCw, size: 11)
                            Text("Refresh")
                                .font(VFont.caption)
                        }
                        .foregroundColor(VColor.primaryBase)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, VSpacing.sm)
            }
        } else {
            HStack(alignment: .top, spacing: VSpacing.lg) {
                categorySidebar

                VStack(spacing: VSpacing.md) {
                    VSearchBar(placeholder: "Search skills", text: $globalSkillSearchQuery)

                    if categoryFilteredSkills.isEmpty {
                        VEmptyState(
                            title: "No skills in this category",
                            subtitle: selectedCategory.map { "No installed skills matched \($0.displayName)" } ?? "",
                            icon: "tray"
                        )
                        .frame(minHeight: 100)
                    } else {
                        ScrollView {
                            VStack(spacing: VSpacing.md) {
                                ForEach(categoryFilteredSkills) { skill in
                                    skillCard(skill)
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func skillCard(_ skill: SkillInfo) -> some View {
        return VStack(alignment: .leading, spacing: 0) {
            // Top row: icon + info + remove button
            HStack(alignment: .top, spacing: VSpacing.md) {
                skillIcon(skill.emoji)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(skill.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.contentDefault)

                    Text(skill.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(2)

                    VSkillTypePill(source: skill.source)
                        .padding(.top, VSpacing.sm)
                }

                Spacer(minLength: VSpacing.lg)

                // Remove button
                Button {
                    skillToDelete = skill
                } label: {
                    Text("Remove")
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .strokeBorder(VColor.systemNegativeStrong, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }

            // Details navigation
            HStack {
                Spacer()
                VButton(
                    label: "Details",
                    rightIcon: VIcon.chevronRight.rawValue,
                    style: .outlined
                ) {
                    withAnimation(VAnimation.fast) {
                        selectedInstalledSkillId = skill.id
                    }
                }
            }
            .padding(.top, VSpacing.xs)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .contentShape(Rectangle())
        .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
    }

    // MARK: - Installed Skill Detail View

    @ViewBuilder
    private func installedSkillDetailView(_ skill: SkillInfo) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {

            // Title row with back button
            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Back",
                    iconOnly: VIcon.chevronLeft.rawValue,
                    style: .ghost,
                    tooltip: "Back to Skills"
                ) {
                    withAnimation(VAnimation.standard) {
                        selectedInstalledSkillId = nil
                    }
                }

                skillIcon(skill.emoji)

                Text(skill.name)
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.contentDefault)

                if skill.updateAvailable {
                    Text("UPDATE")
                        .font(VFont.small)
                        .foregroundColor(VColor.systemNegativeHover)
                }

                // Source badge
                Text(sourceLabel(skill.source))
                    .font(VFont.small)
                    .foregroundColor(sourceBadgeColor(skill.source))
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(sourceBadgeColor(skill.source).opacity(0.15))
                    )

                // Provenance badge
                if let label = provenanceLabel(skill) {
                    Text(label)
                        .font(VFont.small)
                        .foregroundColor(provenanceBadgeColor(skill))
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, 2)
                        .background(
                            Capsule()
                                .fill(provenanceBadgeColor(skill).opacity(0.15))
                        )
                }

                Spacer()

                if skill.source == "managed" {
                    VButton(label: "Remove", icon: VIcon.trash.rawValue, style: .danger) {
                        skillToDelete = skill
                    }
                }
            }

            // Description
            if !skill.description.isEmpty {
                Text(skill.description)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Meta info
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

                // Source link for third-party skills
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

            // Two-pane content: file list + file content viewer
            HStack(alignment: .top, spacing: VSpacing.md) {
                // Left: file list (always fixed width)
                skillFilesSection
                    .frame(width: 280, alignment: .topLeading)
                    .frame(maxHeight: .infinity)

                // Right: file content viewer (always visible)
                if let selectedPath = expandedFilePath,
                   let filesResponse = skillsManager.selectedSkillFiles,
                   let file = filesResponse.files.first(where: { $0.path == selectedPath }),
                   !file.isBinary,
                   let content = file.content {
                    skillFileContentPane(file: file, content: content)
                } else {
                    // Empty state when no file is selected or all files are binary
                    VEmptyState(
                        title: hasViewableFiles ? "Select a file to view" : "No viewable files",
                        icon: VIcon.fileText.rawValue
                    )
                    .background(VColor.surfaceOverlay)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        }
        .onAppear {
            skillsManager.fetchSkillFiles(skillId: skill.id)
        }
        .onChange(of: skillsManager.selectedSkillFiles?.files.map(\.path)) {
            // Auto-select SKILL.md (or the first text file) when files load
            if expandedFilePath == nil, let files = skillsManager.selectedSkillFiles?.files {
                let skillMd = files.first { $0.path == "SKILL.md" && !$0.isBinary && $0.content != nil }
                let firstText = files.first { !$0.isBinary && $0.content != nil }
                expandedFilePath = (skillMd ?? firstText)?.path
            }
        }
        .onDisappear {
            expandedFilePath = nil
            skillsManager.clearSkillDetail()
        }
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "bundled":
            return "Core"
        case "managed", "clawhub":
            return "Installed"
        case "workspace":
            return "Created"
        case "extra":
            return "Extra"
        default:
            return source.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    private func provenanceLabel(_ skill: SkillInfo) -> String? {
        guard let provenance = skill.provenance else { return nil }
        if provenance.kind == "first-party" {
            return provenance.provider ?? "Vellum"
        } else if provenance.kind == "third-party" {
            return provenance.provider ?? "Third-party"
        } else if provenance.kind == "local" {
            return "Local"
        }
        return nil
    }

    private func sourceBadgeColor(_ source: String) -> Color {
        switch source {
        case "bundled":
            return VColor.primaryBase
        case "managed", "clawhub":
            return VColor.systemPositiveStrong
        case "workspace":
            return VColor.systemNegativeHover
        default:
            return VColor.contentTertiary
        }
    }

    private func provenanceBadgeColor(_ skill: SkillInfo) -> Color {
        guard let provenance = skill.provenance else { return VColor.contentTertiary }
        switch provenance.kind {
        case "first-party":
            return VColor.primaryBase
        case "third-party":
            return VColor.systemNegativeHover
        default:
            return VColor.contentTertiary
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

    @ViewBuilder
    private func skillFileContentPane(file: SkillFileEntry, content: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // File header
            FileContentHeaderBar(
                icon: fileIcon(for: file.mimeType),
                fileName: file.path,
                fileSize: formatFileSize(file.size)
            )

            Divider().background(VColor.borderBase)

            // File content
            HighlightedTextView(
                text: .constant(content),
                language: SyntaxLanguage.detect(fileName: file.path, mimeType: file.mimeType),
                isEditable: false
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func skillIcon(_ emoji: String?) -> some View {
        if let emoji, !emoji.isEmpty {
            Text(emoji)
                .font(.system(size: 20))
                .frame(width: 24, height: 24)
        } else {
            VIconView(.zap, size: 13)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 24, height: 24)
        }
    }

    // MARK: - Skill Files

    @ViewBuilder
    private var skillFilesSection: some View {
        if skillsManager.isLoadingSkillFiles || skillsManager.skillFilesError != nil ||
            (skillsManager.selectedSkillFiles != nil && !skillsManager.selectedSkillFiles!.files.isEmpty) {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack {
                    Text("Files")
                        .font(VFont.headline)
                        .foregroundColor(VColor.contentDefault)
                    Spacer()
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)

                Divider().background(VColor.borderBase)

                // Content (loading, error, or tree)
                VStack(spacing: 0) {
                    if skillsManager.isLoadingSkillFiles {
                        HStack {
                            Spacer()
                            ProgressView()
                                .controlSize(.small)
                            Spacer()
                        }
                        .padding(.vertical, VSpacing.md)
                    } else if let error = skillsManager.skillFilesError {
                        Text(error)
                            .font(VFont.caption)
                            .foregroundColor(VColor.systemNegativeStrong)
                    } else if let filesResponse = skillsManager.selectedSkillFiles, !filesResponse.files.isEmpty {
                        ScrollView(.vertical) {
                            SkillFileTreeView(
                                files: filesResponse.files,
                                selectedFilePath: $expandedFilePath
                            )
                        }
                    }
                }
                .frame(maxHeight: .infinity, alignment: .topLeading)
            }
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
    }

    private func fileIcon(for mimeType: String) -> VIcon {
        if mimeType.hasPrefix("image/") { return .image }
        if mimeType.hasPrefix("video/") { return .video }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/json" || mimeType == "application/javascript" || mimeType == "application/typescript" { return .fileCode }
        return .file
    }

}
