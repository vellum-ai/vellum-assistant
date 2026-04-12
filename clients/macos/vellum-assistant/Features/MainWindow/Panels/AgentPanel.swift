import SwiftUI
import VellumAssistantShared

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
    @State private var selectedSkillId: String?
    @State private var cachedSelectedSkill: SkillInfo?
    @State private var skillToDelete: SkillInfo?
    @AppStorage("skillsBannerDismissed") private var bannerDismissed = false

    init(onInvokeSkill: ((SkillInfo) -> Void)? = nil, onCreateSkill: (() -> Void)? = nil, onSkillsChanged: (() -> Void)? = nil, connectionManager: GatewayConnectionManager, focusedSkillId: Binding<String?> = .constant(nil)) {
        self.onInvokeSkill = onInvokeSkill
        self.onCreateSkill = onCreateSkill
        self.onSkillsChanged = onSkillsChanged
        self.connectionManager = connectionManager
        _focusedSkillId = focusedSkillId
        _skillsManager = State(wrappedValue: SkillsManager(connectionManager: connectionManager))
    }

    private var isShowingDetail: Bool {
        selectedSkillId != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !isShowingDetail {
                if !bannerDismissed {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.sparkles, size: 14)
                            .foregroundStyle(VColor.primaryBase)
                        tipBannerText
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
                selectedSkillId = skillId
                focusedSkillId = nil
            }
        }
        .onChange(of: focusedSkillId) {
            if let skillId = focusedSkillId {
                selectedSkillId = skillId
                focusedSkillId = nil
            }
        }
        .onChange(of: skillsManager.skills.map(\.id)) {
            onSkillsChanged?()
            if let selectedId = selectedSkillId,
               skillsManager.installingSkillId != selectedId,
               cachedSelectedSkill == nil,
               !skillsManager.skills.contains(where: { $0.id == selectedId }) {
                selectedSkillId = nil
            }
        }
        .onChange(of: skillsManager.filteredSkills.map(\.id)) {
            // Preserve the detail selection across post-install refreshes:
            // after an install, the skill's status flips from "available"
            // to "enabled", which may remove it from the active
            // `filteredSkills` (e.g. under the `.available` filter). The
            // detail view still needs the skill to render its content, so
            // we only clear the selection when the skill is truly gone
            // from the unfiltered `skills` list (and not mid-install).
            if let selectedId = selectedSkillId,
               skillsManager.installingSkillId != selectedId,
               cachedSelectedSkill == nil,
               !skillsManager.skills.contains(where: { $0.id == selectedId }) {
                selectedSkillId = nil
            }
        }
        .sheet(item: $skillToDelete) { skill in
            SkillDeleteConfirmView(
                skillName: skill.name,
                onDelete: {
                    skillsManager.uninstallSkill(id: skill.id)
                    skillToDelete = nil
                    cachedSelectedSkill = nil
                    selectedSkillId = nil
                },
                onCancel: {
                    skillToDelete = nil
                }
            )
        }
    }

    // MARK: - Tip Banner

    private static let createSkillURL = URL(string: "vellum://create-skill")!

    private var tipBannerText: some View {
        HStack(spacing: 0) {
            Text("**Tip:** You can ")
            VLink(
                "create a new custom skill",
                destination: Self.createSkillURL,
                font: VFont.bodyMediumDefault,
                underline: true
            )
            .tint(VColor.primaryBase)
            Text(" by describing what you want in chat.")
        }
    }

    // MARK: - Filter Bar

    @ViewBuilder
    private var filterBar: some View {
        HStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search Skills", text: $skillsManager.searchQuery)
                .overlay(alignment: .trailing) {
                    if skillsManager.isSearching {
                        ProgressView()
                            .controlSize(.small)
                            .padding(.trailing, 28)
                    }
                }
            VDropdown(
                options: SkillFilter.allCases.map { VDropdownOption(label: $0.rawValue, value: $0, icon: $0.icon) },
                selection: $skillsManager.skillFilter,
                maxWidth: 130
            )
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
        VNavItem(
            icon: icon,
            label: label,
            isActive: skillsManager.selectedCategory == category,
            action: {
                withAnimation(VAnimation.fast) { skillsManager.selectedCategory = category }
            }
        ) {
            let count = category.map { skillsManager.categoryCounts[$0, default: 0] } ?? skillsManager.searchFilteredCount
            Text("\(count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .accessibilityLabel("\(label) filter")
        .accessibilityAddTraits(skillsManager.selectedCategory == category ? .isSelected : [])
    }

    // MARK: - Empty State

    private var emptyStateTitle: String {
        if let category = skillsManager.selectedCategory {
            return "No \(category.displayName) Skills"
        }
        switch skillsManager.skillFilter {
        case .all: return "No Skills Available"
        case .installed: return "No Skills Installed"
        case .available: return "No Skills Available"
        case .vellum: return "No Vellum Skills"
        case .community: return "No Community Skills"
        case .custom: return "No Custom Skills"
        }
    }

    private var emptyStateSubtitle: String {
        if skillsManager.selectedCategory != nil {
            return "Try selecting a different category or clearing the filter."
        }
        switch skillsManager.skillFilter {
        case .all: return "Check your connection to the Vellum catalog."
        case .installed: return "Ask your assistant in chat to search for and install new skills."
        case .available: return "All available skills have been installed."
        case .vellum: return "No bundled Vellum skills found."
        case .community: return "No Community skills found. Try installing some from the catalog."
        case .custom: return "Create a custom skill by describing what you want in chat."
        }
    }

    private var emptyStateIcon: String {
        if skillsManager.selectedCategory != nil {
            return VIcon.layoutGrid.rawValue
        }
        switch skillsManager.skillFilter {
        case .all: return VIcon.cloudOff.rawValue
        case .installed: return VIcon.zap.rawValue
        case .available: return VIcon.circleCheck.rawValue
        case .vellum: return VIcon.package.rawValue
        case .community: return VIcon.globe.rawValue
        case .custom: return VIcon.user.rawValue
        }
    }

    // MARK: - Content View

    @ViewBuilder
    private var contentView: some View {
        // Fall back to the unfiltered `skills` list so a detail view that
        // would otherwise be hidden by the active filter (e.g. a just-
        // installed skill viewed under the `.available` filter) still
        // renders. Finally fall back to the cached snapshot taken when
        // the user clicked into the detail, so a transient search
        // refresh doesn't dismiss the detail view.
        // Pair with `.id(skill.id)` so SwiftUI creates a fresh
        // view instance when the selected skill changes.
        if let selectedId = selectedSkillId,
           let skill = skillsManager.filteredSkills.first(where: { $0.id == selectedId })
            ?? skillsManager.skills.first(where: { $0.id == selectedId })
            ?? cachedSelectedSkill {
            SkillDetailView(
                skill: skill,
                skillsManager: skillsManager,
                onBack: {
                    withAnimation(VAnimation.standard) {
                        selectedSkillId = nil
                        cachedSelectedSkill = nil
                    }
                },
                onDelete: { skill in
                    skillToDelete = skill
                }
            )
            .id(skill.id)
        } else if skillsManager.isLoading && skillsManager.baseSkillsEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if skillsManager.isSearching && skillsManager.filteredSkills.isEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if skillsManager.filteredSkills.isEmpty {
            VEmptyState(
                title: emptyStateTitle,
                subtitle: emptyStateSubtitle,
                icon: emptyStateIcon
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.sm) {
                    ForEach(skillsManager.filteredSkills) { skill in
                        if skill.isAvailable {
                            AvailableSkillItemRow(
                                skill: skill,
                                onSelect: {
                                    withAnimation(VAnimation.fast) {
                                        cachedSelectedSkill = skill
                                        selectedSkillId = skill.id
                                    }
                                },
                                onInstall: { skillsManager.installSkill(slug: skill.id) },
                                isInstalling: skillsManager.installingSkillId == skill.id
                            )
                        } else {
                            SkillItemRow(
                                skill: skill,
                                onSelect: {
                                    withAnimation(VAnimation.fast) {
                                        cachedSelectedSkill = skill
                                        selectedSkillId = skill.id
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
}

// MARK: - Skill Item Row

struct SkillItemRow: View {
    let skill: SkillInfo
    let onSelect: () -> Void
    let onDelete: () -> Void

    private var isRemovable: Bool {
        skill.kind == "installed"
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

                        VSkillTypePill(origin: skill.origin)

                        Spacer()
                    }

                    Text(skill.description)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                VButton(
                    label: "Remove",
                    leftIcon: VIcon.trash.rawValue,
                    style: .dangerOutline,
                    action: onDelete
                )
                .disabled(!isRemovable)
                .opacity(isRemovable ? 1.0 : 0.3)
                .if(!isRemovable) { $0.vTooltip("Bundled skills cannot be removed") }
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
    let onSelect: () -> Void
    let onInstall: () -> Void
    var isInstalling: Bool = false

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
                        VSkillTypePill(origin: skill.origin)
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
                        leftIcon: VIcon.arrowDownToLine.rawValue,
                        style: .primary,
                        action: onInstall
                    )
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(skill.name). \(skill.description)")
        .accessibilityAction { onSelect() }
        .accessibilityAction(named: "Install") { onInstall() }
    }
}
