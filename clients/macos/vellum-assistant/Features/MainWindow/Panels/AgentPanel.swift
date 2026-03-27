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
    @State private var selectedInstalledSkillId: String?
    @State private var skillToDelete: SkillInfo?
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
        .onChange(of: skillsManager.filteredSkills.map(\.id)) {
            if let selectedId = selectedInstalledSkillId,
               !skillsManager.filteredSkills.contains(where: { $0.id == selectedId }) {
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
            VSearchBar(placeholder: "Search Skills", text: $skillsManager.searchQuery)
            skillFilterDropdown
                .frame(width: 130)
        }
    }

    private var skillFilterDropdown: some View {
        Button {
            showSkillFilterPopover.toggle()
        } label: {
            HStack(spacing: VSpacing.md) {
                Text(skillsManager.skillFilter.rawValue)
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
        .accessibilityLabel("Skill filter: \(skillsManager.skillFilter.rawValue)")
        .popover(isPresented: $showSkillFilterPopover, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(SkillFilter.allCases, id: \.self) { filter in
                    Button {
                        withAnimation(VAnimation.fast) { skillsManager.skillFilter = filter }
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
                            if skillsManager.skillFilter == filter {
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
                    .accessibilityAddTraits(skillsManager.skillFilter == filter ? .isSelected : [])
                }
            }
            .padding(.vertical, VSpacing.sm)
            .frame(width: 180)
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

    // MARK: - Content View

    @ViewBuilder
    private var contentView: some View {
        if let selectedId = selectedInstalledSkillId,
           let skill = skillsManager.filteredSkills.first(where: { $0.id == selectedId }) {
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
        } else if skillsManager.isLoading && skillsManager.baseSkillsEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if skillsManager.filteredSkills.isEmpty {
            VEmptyState(
                title: skillsManager.skillFilter == .all
                    ? "No Skills Available"
                    : (skillsManager.selectedCategory == nil ? "No Skills Installed" : "No \(skillsManager.selectedCategory!.displayName) Skills"),
                subtitle: skillsManager.skillFilter == .all
                    ? "Check your connection to the Vellum catalog."
                    : (skillsManager.selectedCategory == nil
                        ? "Ask your assistant in chat to search for and install new skills."
                        : "Try selecting a different category or clearing the filter."),
                icon: skillsManager.skillFilter == .all ? VIcon.cloudOff.rawValue : VIcon.zap.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.sm) {
                    ForEach(skillsManager.filteredSkills) { skill in
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
}

// MARK: - Skill Item Row

struct SkillItemRow: View {
    let skill: SkillInfo
    let onSelect: () -> Void
    let onDelete: () -> Void

    private var isRemovable: Bool {
        skill.source == "managed" || skill.source == "clawhub"
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

                        VSkillTypePill(source: skill.source)

                        Spacer()
                    }

                    Text(skill.description)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
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

// MARK: - Available Skill Item Row

struct AvailableSkillItemRow: View {
    let skill: SkillInfo
    let onInstall: () -> Void
    var isInstalling: Bool = false

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.lg) {
            if let emoji = skill.emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: 32))
                    .opacity(0.5)
            }
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    Text(skill.name)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentSecondary)
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
            if isInstalling {
                VLoadingIndicator()
            } else {
                VButton(
                    label: "Install",
                    style: .outlined,
                    size: .compact,
                    action: onInstall
                )
            }
        }
        .padding(VSpacing.lg)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(
                    VColor.borderDisabled,
                    style: StrokeStyle(lineWidth: 2, dash: [6, 4])
                )
        )
    }
}
