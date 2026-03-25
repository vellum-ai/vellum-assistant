import SwiftUI
import VellumAssistantShared

// MARK: - Agent Panel Content (embeddable)

/// The installed skills management content, usable standalone
/// (e.g. inside IntelligencePanel).
struct AgentPanelContent: View {
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onSkillsChanged: (() -> Void)?
    let connectionManager: GatewayConnectionManager

    @State private var skillsManager: SkillsManager
    @State private var selectedInstalledSkillId: String?
    @State private var skillToDelete: SkillInfo?
    @State private var selectedCategory: SkillCategory?
    @State private var globalSkillSearchQuery = ""

    init(onInvokeSkill: ((SkillInfo) -> Void)? = nil, onSkillsChanged: (() -> Void)? = nil, connectionManager: GatewayConnectionManager) {
        self.onInvokeSkill = onInvokeSkill
        self.onSkillsChanged = onSkillsChanged
        self.connectionManager = connectionManager
        _skillsManager = State(wrappedValue: SkillsManager(connectionManager: connectionManager))
    }

    private var normalizedSkillQuery: String {
        globalSkillSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var hasActiveSearch: Bool { !normalizedSkillQuery.isEmpty }

    private var isShowingDetail: Bool {
        selectedInstalledSkillId != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !isShowingDetail {
                filterBar
            }
            HStack(alignment: .top, spacing: VSpacing.xxl) {
                if !isShowingDetail {
                    categorySidebar
                        .frame(width: 220)
                }
                contentView
            }
            .padding(.top, VSpacing.lg)
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
               !filteredSkills.contains(where: { $0.id == selectedId }) {
                selectedInstalledSkillId = nil
            }
        }
        .onChange(of: selectedCategory) {
            if let selectedId = selectedInstalledSkillId,
               !filteredSkills.contains(where: { $0.id == selectedId }) {
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

    // MARK: - Filter Bar

    @ViewBuilder
    private var filterBar: some View {
        HStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search Skills", text: $globalSkillSearchQuery)
        }
    }

    // MARK: - Category Sidebar

    private var categorySidebar: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            categorySidebarRow(icon: VIcon.layoutGrid.rawValue, label: "All", category: nil)
            ForEach(SkillCategory.allCases.sorted { $0.displayName < $1.displayName }, id: \.rawValue) { category in
                categorySidebarRow(icon: category.icon.rawValue, label: category.displayName, category: category)
            }
        }
    }

    private func categorySidebarRow(icon: String, label: String, category: SkillCategory?) -> some View {
        VSidebarRow(
            icon: icon,
            label: label,
            isActive: selectedCategory == category,
            action: {
                withAnimation(VAnimation.fast) { selectedCategory = category }
            }
        ) {
            Text("\(categoryCount(for: category))")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .accessibilityLabel("\(label) filter")
        .accessibilityAddTraits(selectedCategory == category ? .isSelected : [])
    }

    private func categoryCount(for category: SkillCategory?) -> Int {
        let base = searchFilteredSkills
        guard let category else { return base.count }
        return base.filter { inferCategory($0) == category }.count
    }

    // MARK: - Filtering

    private var userSkills: [SkillInfo] {
        skillsManager.skills
    }

    /// Skills filtered by search query only.
    private var searchFilteredSkills: [SkillInfo] {
        guard hasActiveSearch else { return userSkills }
        let query = normalizedSkillQuery
        return userSkills.filter {
            $0.name.lowercased().contains(query) ||
            $0.description.lowercased().contains(query) ||
            $0.id.lowercased().contains(query) ||
            sourceLabel($0.source).lowercased().contains(query)
        }
    }

    /// Skills filtered by both search and selected category, installed first then alphabetical.
    private var filteredSkills: [SkillInfo] {
        let base = searchFilteredSkills
        let filtered: [SkillInfo]
        if let category = selectedCategory {
            filtered = base.filter { inferCategory($0) == category }
        } else {
            filtered = base
        }
        return filtered.sorted { a, b in
            let aInstalled = (a.source == "managed" || a.source == "clawhub")
            let bInstalled = (b.source == "managed" || b.source == "clawhub")
            if aInstalled != bInstalled { return aInstalled }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    // MARK: - Content View

    @ViewBuilder
    private var contentView: some View {
        if let selectedId = selectedInstalledSkillId,
           let skill = filteredSkills.first(where: { $0.id == selectedId }) {
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
        } else if skillsManager.isLoading && userSkills.isEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if filteredSkills.isEmpty {
            VEmptyState(
                title: selectedCategory == nil ? "No Skills Installed" : "No \(selectedCategory!.displayName) Skills",
                subtitle: selectedCategory == nil
                    ? "Ask your assistant in chat to search for and install new skills."
                    : "Try selecting a different category or clearing the filter.",
                icon: VIcon.zap.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.sm) {
                    ForEach(filteredSkills) { skill in
                        SkillItemRow(
                            skill: skill,
                            onSelect: {
                                withAnimation(VAnimation.fast) {
                                    selectedInstalledSkillId = skill.id
                                }
                            },
                            onDelete: {
                                skillToDelete = skill
                            }
                        )
                    }
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
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

// MARK: - Skill Item Row

struct SkillItemRow: View {
    let skill: SkillInfo
    let onSelect: () -> Void
    let onDelete: () -> Void

    private var isRemovable: Bool {
        skill.source == "managed" || skill.source == "clawhub"
    }

    private var category: SkillCategory {
        inferCategory(skill)
    }

    var body: some View {
        VCard(padding: VSpacing.lg, action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                if let emoji = skill.emoji, !emoji.isEmpty {
                    Text(emoji)
                        .font(.system(size: 32))
                }

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(alignment: .center, spacing: VSpacing.sm) {
                        Text(skill.name)
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentEmphasized)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        VSkillTypePill(source: skill.source)

                        Spacer()
                    }

                    Text(skill.description)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                if isRemovable {
                    VButton(
                        label: "Delete",
                        iconOnly: VIcon.trash.rawValue,
                        style: .dangerGhost,
                        size: .compact,
                        action: onDelete
                    )
                    .accessibilityLabel("Uninstall skill")
                }
            }
        }
        .contextMenu {
            Button("Remove", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
