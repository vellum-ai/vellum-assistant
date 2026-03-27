import SwiftUI
import VellumAssistantShared

// MARK: - Skill Filter

private enum SkillFilter: String, CaseIterable {
    case all = "All"
    case installed = "Installed"
    case available = "Available"
    case vellum = "Vellum"
    case openclaw = "OpenClaw"
    case custom = "Custom"

    var icon: VIcon {
        switch self {
        case .all: return .layoutGrid
        case .installed: return .circleCheck
        case .available: return .arrowDownToLine
        case .vellum: return .package
        case .openclaw: return .globe
        case .custom: return .user
        }
    }

    static var statusFilters: [SkillFilter] { [.all, .installed, .available] }
    static var sourceFilters: [SkillFilter] { [.vellum, .openclaw, .custom] }
}

// MARK: - Agent Panel Content (embeddable)

/// The installed skills management content, usable standalone
/// (e.g. inside IntelligencePanel).
struct AgentPanelContent: View {
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onCreateSkill: (() -> Void)?
    var onSkillsChanged: (() -> Void)?
    let connectionManager: GatewayConnectionManager
    @Binding var focusedSkillId: String?

    @State private var skillsManager: SkillsManager
    @State private var selectedInstalledSkillId: String?
    @State private var skillToDelete: SkillInfo?
    @State private var selectedCategory: SkillCategory?
    @State private var globalSkillSearchQuery = ""
    @State private var skillFilter: SkillFilter = .all
    @State private var showSkillFilterPopover = false
    @AppStorage("skillsBannerDismissed") private var bannerDismissed = false

    init(onInvokeSkill: ((SkillInfo) -> Void)? = nil, onCreateSkill: (() -> Void)? = nil, onSkillsChanged: (() -> Void)? = nil, connectionManager: GatewayConnectionManager, focusedSkillId: Binding<String?> = .constant(nil)) {
        self.onInvokeSkill = onInvokeSkill
        self.onCreateSkill = onCreateSkill
        self.onSkillsChanged = onSkillsChanged
        self.connectionManager = connectionManager
        _focusedSkillId = focusedSkillId
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
                if !bannerDismissed {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.sparkles, size: 14)
                            .foregroundStyle(VColor.primaryBase)
                        Text("**Tip:** You can [create a new custom skill](vellum://create-skill) by describing what you want in chat.")
                            .tint(VColor.primaryBase)
                        Spacer()
                        Button(action: {
                            withAnimation(VAnimation.fast) { bannerDismissed = true }
                        }) {
                            VIconView(.x, size: 12)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Dismiss tip")
                    }
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .background(VColor.primaryBase.opacity(0.10))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.primaryBase.opacity(0.18), lineWidth: 1)
                    )
                    .environment(\.openURL, OpenURLAction { _ in
                        onCreateSkill?()
                        return .handled
                    })
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Tip: You can create a new custom skill by describing what you want in chat.")
                    .accessibilityAddTraits(.isButton)
                    .padding(.bottom, VSpacing.lg)
                }
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
            if let skillId = focusedSkillId {
                selectedInstalledSkillId = skillId
                focusedSkillId = nil
            }
        }
        .onChange(of: focusedSkillId) {
            if let skillId = focusedSkillId {
                selectedInstalledSkillId = skillId
                focusedSkillId = nil
            }
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
        .onChange(of: skillFilter) {
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
            skillFilterDropdown
                .frame(width: 150)
        }
    }

    private var skillFilterDropdown: some View {
        Button {
            showSkillFilterPopover.toggle()
        } label: {
            HStack(spacing: VSpacing.md) {
                Text(skillFilter.rawValue)
                    .foregroundStyle(VColor.contentDefault)
                    .font(VFont.bodyMediumLighter)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VIconView(.chevronDown, size: 13)
                    .foregroundStyle(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .frame(height: 32)
            .vInputChrome()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Skill filter: \(skillFilter.rawValue)")
        .popover(isPresented: $showSkillFilterPopover, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                // Status filters
                ForEach(SkillFilter.statusFilters, id: \.self) { filter in
                    filterRow(filter)
                }
                Divider()
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.xs)
                // Source filters
                ForEach(SkillFilter.sourceFilters, id: \.self) { filter in
                    filterRow(filter)
                }
            }
            .padding(.vertical, VSpacing.sm)
            .frame(width: 180)
        }
    }

    private func filterRow(_ filter: SkillFilter) -> some View {
        Button {
            withAnimation(VAnimation.fast) { skillFilter = filter }
            showSkillFilterPopover = false
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(filter.icon, size: 14)
                    .foregroundStyle(VColor.contentDefault)
                    .frame(width: 20)
                Text(filter.rawValue)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                if skillFilter == filter {
                    VIconView(.check, size: 12)
                        .foregroundStyle(VColor.primaryBase)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(filter.rawValue) skills")
        .accessibilityAddTraits(skillFilter == filter ? .isSelected : [])
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
        VNavItem(
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
        switch skillFilter {
        case .all: return skillsManager.skills
        case .installed: return skillsManager.skills.filter { $0.isInstalled }
        case .available: return skillsManager.skills.filter { $0.isAvailable }
        case .vellum: return skillsManager.skills.filter {
            $0.source == "bundled" || ($0.source == "managed" && $0.provenance?.kind == "first-party")
        }
        case .openclaw: return skillsManager.skills.filter {
            $0.source == "clawhub" || ($0.source == "managed" && $0.provenance?.kind == "third-party")
        }
        case .custom: return skillsManager.skills.filter {
            $0.source == "workspace" || $0.source == "extra" || ($0.source == "managed" && $0.provenance?.kind == "local")
        }
        }
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
            if a.isInstalled != b.isInstalled { return a.isInstalled }
            let aManaged = (a.source == "managed" || a.source == "clawhub")
            let bManaged = (b.source == "managed" || b.source == "clawhub")
            if a.isInstalled && b.isInstalled && aManaged != bManaged { return aManaged }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    // MARK: - Empty State

    private var emptyStateTitle: String {
        if let category = selectedCategory {
            return "No \(category.displayName) Skills"
        }
        switch skillFilter {
        case .all: return "No Skills Available"
        case .installed: return "No Skills Installed"
        case .available: return "No Skills Available"
        case .vellum: return "No Vellum Skills"
        case .openclaw: return "No OpenClaw Skills"
        case .custom: return "No Custom Skills"
        }
    }

    private var emptyStateSubtitle: String {
        if selectedCategory != nil {
            return "Try selecting a different category or clearing the filter."
        }
        switch skillFilter {
        case .all: return "Check your connection to the Vellum catalog."
        case .installed: return "Ask your assistant in chat to search for and install new skills."
        case .available: return "All available skills have been installed."
        case .vellum: return "No bundled Vellum skills found."
        case .openclaw: return "No OpenClaw skills found. Try installing some from the catalog."
        case .custom: return "Create a custom skill by describing what you want in chat."
        }
    }

    private var emptyStateIcon: String {
        if selectedCategory != nil {
            return VIcon.layoutGrid.rawValue
        }
        switch skillFilter {
        case .all: return VIcon.cloudOff.rawValue
        case .installed: return VIcon.zap.rawValue
        case .available: return VIcon.circleCheck.rawValue
        case .vellum: return VIcon.package.rawValue
        case .openclaw: return VIcon.globe.rawValue
        case .custom: return VIcon.user.rawValue
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
                title: emptyStateTitle,
                subtitle: emptyStateSubtitle,
                icon: emptyStateIcon
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.sm) {
                    ForEach(filteredSkills) { skill in
                        if skill.isAvailable {
                            AvailableSkillItemRow(
                                skill: skill,
                                onInstall: { skillsManager.installSkill(slug: skill.id) },
                                isInstalling: skillsManager.installingSkillId == skill.id
                            )
                        } else {
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
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "bundled":
            return "Vellum"
        case "clawhub":
            return "OpenClaw"
        case "managed":
            return "Custom"
        case "workspace":
            return "Custom"
        case "catalog":
            return "Available"
        case "extra":
            return "Custom"
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
        VCard(action: onSelect) {
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

                        VSkillTypePill(source: skill.source, provenanceKind: skill.provenance?.kind)

                        Spacer()
                    }

                    Text(skill.description)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                VButton(
                    label: "Delete",
                    iconOnly: VIcon.trash.rawValue,
                    style: .dangerGhost,
                    size: .compact,
                    action: onDelete
                )
                .disabled(!isRemovable)
                .opacity(isRemovable ? 1.0 : 0.3)
                .vTooltip(isRemovable ? "Remove skill" : "Bundled skills cannot be removed")
                .accessibilityLabel(isRemovable ? "Uninstall skill" : "Core skill cannot be removed")
            }
        }
        .if(isRemovable) { view in
            view.contextMenu {
                Button("Remove", role: .destructive, action: onDelete)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Available Skill Item Row

struct AvailableSkillItemRow: View {
    let skill: SkillInfo
    let onInstall: () -> Void
    var isInstalling: Bool = false

    var body: some View {
        VCard {
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
                        if skill.source == "clawhub" {
                            VSkillTypePill(type: .openclaw)
                        } else if skill.source == "catalog" {
                            VSkillTypePill(type: .vellum)
                        }
                        VSkillTypePill(type: .available)
                        Spacer()
                    }
                    Text(skill.description)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if isInstalling {
                    VLoadingIndicator()
                } else {
                    VButton(
                        label: "Install",
                        iconOnly: VIcon.arrowDownToLine.rawValue,
                        style: .ghost,
                        size: .compact,
                        action: onInstall
                    )
                    .vTooltip("Install skill")
                }
            }
        }
    }
}
