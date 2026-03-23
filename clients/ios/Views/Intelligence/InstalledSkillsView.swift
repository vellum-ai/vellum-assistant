#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

private enum SkillStateFilter: String, CaseIterable {
    case all = "All"
    case enabled = "Enabled"
    case disabled = "Disabled"

    func matches(_ state: String) -> Bool {
        switch self {
        case .all: return true
        case .enabled: return state == "enabled"
        case .disabled: return state == "disabled"
        }
    }
}

struct InstalledSkillsView: View {
    @ObservedObject var skillsStore: SkillsStore
    @State private var skillToUninstall: SkillInfo?
    @State private var showUninstallConfirmation = false
    @State private var searchText = ""
    @State private var stateFilter: SkillStateFilter = .all

    private var filteredSkills: [SkillInfo] {
        skillsStore.skills.filter { skill in
            guard stateFilter.matches(skill.state) else { return false }
            guard !searchText.isEmpty else { return true }
            let query = searchText.lowercased()
            return skill.name.lowercased().contains(query)
                || skill.description.lowercased().contains(query)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            Group {
                if skillsStore.isLoading && skillsStore.skills.isEmpty {
                    loadingState
                } else if filteredSkills.isEmpty && !skillsStore.skills.isEmpty {
                    noMatchesState
                } else if skillsStore.skills.isEmpty {
                    emptyState
                } else {
                    skillsList
                }
            }
        }
        .searchable(text: $searchText, prompt: "Search skills...")
        .navigationTitle("Skills")
        .refreshable {
            skillsStore.fetchSkills(force: true)
        }
        .alert("Uninstall Skill", isPresented: $showUninstallConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Uninstall", role: .destructive) {
                if let skill = skillToUninstall {
                    skillsStore.uninstallSkill(id: skill.id)
                }
            }
        } message: {
            if let skill = skillToUninstall {
                Text("Are you sure you want to uninstall \"\(skill.name)\"? This action cannot be undone.")
            }
        }
    }

    // MARK: - Filter Bar

    private var filterBar: some View {
        Picker("State", selection: $stateFilter) {
            ForEach(SkillStateFilter.allCases, id: \.self) { filter in
                Text(filter.rawValue).tag(filter)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Skills List

    private var skillsList: some View {
        List {
            Section {
                ForEach(filteredSkills) { skill in
                    NavigationLink {
                        SkillDetailView(skill: skill, skillsStore: skillsStore)
                    } label: {
                        skillRow(skill)
                    }
                    .swipeActions(edge: .leading) {
                        if skill.state == "enabled" {
                            Button {
                                skillsStore.disableSkill(name: skill.name)
                            } label: {
                                Label { Text("Disable") } icon: { VIconView(.circlePlay, size: 12) }
                            }
                            .tint(.orange)
                        } else {
                            Button {
                                skillsStore.enableSkill(name: skill.name)
                            } label: {
                                Label { Text("Enable") } icon: { VIconView(.circlePlay, size: 12) }
                            }
                            .tint(.green)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            skillToUninstall = skill
                            showUninstallConfirmation = true
                        } label: {
                            Label { Text("Uninstall") } icon: { VIconView(.trash, size: 12) }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Skill Row

    private func skillRow(_ skill: SkillInfo) -> some View {
        HStack(spacing: VSpacing.sm) {
            Text(skill.emoji ?? "")
                .font(.system(size: 24))
                .frame(width: 32)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(skill.name)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)

                    stateBadge(skill.state)
                }

                if !skill.description.isEmpty {
                    Text(skill.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(2)
                }
            }

            Spacer()
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Skill: \(skill.name), \(skill.state)")
        .accessibilityHint("Opens skill details")
    }

    // MARK: - State Badge

    private func stateBadge(_ state: String) -> some View {
        let color: Color = {
            switch state {
            case "enabled": return .green
            case "disabled": return .secondary
            default: return .orange
            }
        }()

        return Text(state.capitalized)
            .font(.caption2)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundColor(color)
    }

    // MARK: - Empty States

    private var emptyState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.brain, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("No Skills Installed")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Ask your assistant in chat to search for and install new skills.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No skills installed. Ask your assistant in chat to search for and install new skills.")
    }

    private var noMatchesState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.search, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("No Matching Skills")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Try adjusting your search or filters.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No matching skills. Try adjusting your search or filters.")
    }

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading skills...")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
