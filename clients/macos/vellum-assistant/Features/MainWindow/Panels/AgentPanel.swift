import SwiftUI
import VellumAssistantShared

// MARK: - Agent Panel Content (embeddable)

/// The installed skills management content, usable standalone
/// (e.g. inside IntelligencePanel).
struct AgentPanelContent: View {
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onSkillsChanged: (() -> Void)?
    let daemonClient: GatewayConnectionManager

    @StateObject private var skillsManager: SkillsManager
    @State private var selectedInstalledSkillId: String?
    @State private var skillToDelete: SkillInfo?
    @State private var selectedCategories: Set<SkillCategory> = []
    @State private var globalSkillSearchQuery = ""
    @State private var showFilterPopover = false

    init(onInvokeSkill: ((SkillInfo) -> Void)? = nil, onSkillsChanged: (() -> Void)? = nil, daemonClient: GatewayConnectionManager) {
        self.onInvokeSkill = onInvokeSkill
        self.onSkillsChanged = onSkillsChanged
        self.daemonClient = daemonClient
        _skillsManager = StateObject(wrappedValue: SkillsManager(daemonClient: daemonClient))
    }

    private var normalizedSkillQuery: String {
        globalSkillSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
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
            SkillDetailView(
                skill: skill,
                skillsManager: skillsManager,
                onBack: {
                    withAnimation(VAnimation.standard) {
                        selectedInstalledSkillId = nil
                    }
                },
                onDelete: { skill in
                    skillToDelete = skill
                }
            )
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

        private var isRemovable: Bool {
            skill.source == "managed" || skill.source == "clawhub"
        }

        var body: some View {
            VInteractiveCard(action: onSelect) {
                HStack(alignment: .center, spacing: VSpacing.lg) {
                    skillIcon(skill.emoji)

                    VStack(alignment: .leading, spacing: VSpacing.sm) {
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

                        Text(skill.description)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, minHeight: 28, alignment: .topLeading)
                    }
                }
            }
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
}
