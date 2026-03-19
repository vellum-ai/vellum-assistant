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
    @State private var selectedCategories: Set<SkillCategory> = []
    @State private var globalSkillSearchQuery = ""
    @State private var expandedFilePath: String?
    @State private var skillFileViewMode: FileViewMode = .source
    @State private var showFilterPopover = false

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
        skillsManager.selectedSkillFiles?.files.contains { !$0.isBinary && $0.content != nil } ?? true
    }

    private var hasActiveSearch: Bool { !normalizedSkillQuery.isEmpty }

    private var allCategoriesSelected: Bool {
        selectedCategories.isEmpty || selectedCategories.count == SkillCategory.allCases.count
    }

    /// Dynamic subtitle for the category-filtered empty state.
    private var categoryEmptySubtitle: String {
        let sorted = selectedCategories.sorted { $0.displayName < $1.displayName }
        if sorted.count <= 2 {
            let names = sorted.map(\.displayName).joined(separator: " or ")
            return "No installed skills match \(names)"
        } else {
            return "No installed skills in \(sorted.count) selected categories"
        }
    }

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
            if let selectedId = selectedInstalledSkillId,
               !categoryFilteredSkills.contains(where: { $0.id == selectedId }) {
                selectedInstalledSkillId = nil
            }
        }
        .onChange(of: selectedCategories) {
            if let selectedId = selectedInstalledSkillId,
               !categoryFilteredSkills.contains(where: { $0.id == selectedId }) {
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

    private var userSkills: [SkillInfo] {
        skillsManager.skills
    }

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

    /// Installed skills further filtered by selected categories, sorted with installed first then alphabetically.
    private var categoryFilteredSkills: [SkillInfo] {
        let filtered: [SkillInfo]
        if allCategoriesSelected {
            filtered = filteredUserSkills
        } else {
            filtered = filteredUserSkills.filter { skill in
                selectedCategories.contains(inferCategory(skill))
            }
        }
        return filtered.sorted { a, b in
            let aInstalled = (a.source == "managed" || a.source == "clawhub")
            let bInstalled = (b.source == "managed" || b.source == "clawhub")
            if aInstalled != bInstalled { return aInstalled }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    // MARK: - Category Filter Dropdown

    /// Categories sorted alphabetically by display name.
    private var sortedCategories: [SkillCategory] {
        SkillCategory.allCases.sorted { $0.displayName < $1.displayName }
    }

    private func categoryBinding(for category: SkillCategory) -> Binding<Bool> {
        Binding(
            get: { selectedCategories.contains(category) },
            set: { isOn in
                withAnimation(VAnimation.fast) {
                    if isOn { selectedCategories.insert(category) }
                    else { selectedCategories.remove(category) }
                }
            }
        )
    }

    private var filterLabel: String {
        if allCategoriesSelected {
            return "All"
        }
        let sorted = selectedCategories.sorted { $0.displayName < $1.displayName }
        if sorted.count <= 2 {
            return sorted.map(\.displayName).joined(separator: ", ")
        }
        return "\(sorted.count) categories"
    }

    @ViewBuilder
    private var categoryFilterDropdown: some View {
        Button {
            showFilterPopover.toggle()
        } label: {
            HStack(spacing: VSpacing.md) {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.filter, size: 13)
                        .foregroundColor(VColor.contentTertiary)
                    Text(filterLabel)
                        .foregroundColor(VColor.contentDefault)
                }
                .font(VFont.body)
                .frame(maxWidth: .infinity, alignment: .leading)

                VIconView(.chevronDown, size: 13)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .frame(height: 32)
            .vInputChrome()
        }
        .buttonStyle(.plain)
        .frame(width: 200)
        .popover(isPresented: $showFilterPopover, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(VAnimation.fast) {
                        selectedCategories.removeAll()
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.layoutGrid, size: 14)
                            .foregroundColor(VColor.contentDefault)
                            .frame(width: 20)
                        Text("All")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                        Spacer()
                    }
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Divider().padding(.horizontal, VSpacing.sm)

                ForEach(sortedCategories, id: \.rawValue) { category in
                    Button {
                        withAnimation(VAnimation.fast) {
                            if selectedCategories.contains(category) {
                                selectedCategories.remove(category)
                            } else {
                                selectedCategories.insert(category)
                            }
                        }
                    } label: {
                        HStack(spacing: VSpacing.sm) {
                            VIconView(category.icon, size: 14)
                                .foregroundColor(VColor.contentDefault)
                                .frame(width: 20)
                            Text(category.displayName)
                                .font(VFont.body)
                                .foregroundColor(VColor.contentDefault)
                            Spacer()
                            if selectedCategories.contains(category) {
                                VIconView(.check, size: 12)
                                    .foregroundColor(VColor.primaryBase)
                            }
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, VSpacing.sm)
            .frame(width: 220)
        }
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
        } else if userSkills.isEmpty {
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
        } else {
            VStack(spacing: VSpacing.md) {
                HStack(spacing: VSpacing.sm) {
                    VSearchBar(placeholder: "Search skills", text: $globalSkillSearchQuery)
                    categoryFilterDropdown
                }

                if categoryFilteredSkills.isEmpty {
                    VEmptyState(
                        title: "No skills in selected categories",
                        subtitle: categoryEmptySubtitle,
                        icon: "tray"
                    )
                    .frame(minHeight: 100)
                } else {
                    ScrollView {
                        LazyVGrid(
                            columns: [
                                GridItem(.flexible(), spacing: VSpacing.md),
                                GridItem(.flexible(), spacing: VSpacing.md)
                            ],
                            spacing: VSpacing.md
                        ) {
                            ForEach(categoryFilteredSkills) { skill in
                                skillCard(skill)
                            }
                        }
                    }
                }
            }
        }
    }

    private func skillCard(_ skill: SkillInfo) -> some View {
        SkillCardButton(skill: skill) {
            withAnimation(VAnimation.fast) {
                selectedInstalledSkillId = skill.id
            }
        } onDelete: {
            skillToDelete = skill
        }
    }

    // MARK: - Skill Card

    private struct SkillCardButton: View {
        let skill: SkillInfo
        let onSelect: () -> Void
        let onDelete: () -> Void
        @State private var isHovered = false

        private var isRemovable: Bool {
            skill.source == "managed" || skill.source == "clawhub"
        }

        var body: some View {
            Button(action: onSelect) {
                HStack(alignment: .center, spacing: VSpacing.lg) {
                    // Icon — centered vertically, large
                    skillIcon(skill.emoji)

                    // Text content
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        // Header: name + tag + trash on same line
                        HStack(spacing: VSpacing.sm) {
                            Text(skill.name)
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.contentDefault)
                                .lineLimit(1)
                                .truncationMode(.tail)

                            Spacer()

                            VSkillTypePill(source: skill.source)

                            if isRemovable {
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

                        // Description — fixed 2-line height for uniform cards
                        Text(skill.description)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, minHeight: 28, alignment: .topLeading)
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isHovered ? VColor.surfaceActive : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.xl)
                        .stroke(VColor.borderDisabled, lineWidth: 2)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .onHover { isHovered = $0 }
            .contextMenu {
                Button("Remove", role: .destructive, action: onDelete)
            }
        }

        @ViewBuilder
        private func skillIcon(_ emoji: String?) -> some View {
            if let emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: 32))
                    .frame(width: 40, height: 40)
            } else {
                VIconView(.zap, size: 20)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 40, height: 40)
            }
        }
    }

    // MARK: - Installed Skill Detail View

    @ViewBuilder
    private func installedSkillDetailView(_ skill: SkillInfo) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Title row: back + icon + name + tag + delete
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

                // Small inline icon
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
                        skillToDelete = skill
                    }
                }
            }

            // Description
            if !skill.description.isEmpty {
                Text(skill.description)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
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

            // Two-pane file browser — two rounded cards side by side (matching workspace)
            HStack(alignment: .top, spacing: VSpacing.xl) {
                // Left: file tree sidebar — rounded card with background
                skillFilesSection
                    .frame(width: 280, alignment: .topLeading)
                    .frame(maxHeight: .infinity)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(VColor.surfaceBase)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))

                // Right: file content viewer — rounded card with background
                Group {
                    if let selectedPath = expandedFilePath,
                       let filesResponse = skillsManager.selectedSkillFiles,
                       let file = filesResponse.files.first(where: { $0.path == selectedPath }),
                       !file.isBinary,
                       let content = file.content {
                        FileContentView(
                            fileName: file.path,
                            mimeType: file.mimeType,
                            content: .constant(content),
                            viewMode: $skillFileViewMode
                        )
                    } else {
                        VEmptyState(
                            title: hasViewableFiles ? "Select a file to view" : "No viewable files",
                            icon: VIcon.fileText.rawValue
                        )
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(VColor.surfaceBase)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                // Header — height matches FileContentHeaderBar (36pt)
                HStack {
                    Text("Files")
                        .font(VFont.headline)
                        .foregroundColor(VColor.contentDefault)
                    Spacer()
                }
                .padding(.horizontal, VSpacing.md)
                .frame(height: 36)

                Divider().background(VColor.borderBase)

                // Content — matches WorkspaceTreeSidebar content
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
