#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct InstalledSkillsView: View {
    @ObservedObject var skillsStore: SkillsStore
    @State private var skillToUninstall: SkillInfo?
    @State private var showUninstallConfirmation = false

    var body: some View {
        Group {
            if skillsStore.isLoading && skillsStore.skills.isEmpty {
                loadingState
            } else if skillsStore.skills.isEmpty {
                emptyState
            } else {
                skillsList
            }
        }
        .navigationTitle("Installed Skills")
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

    // MARK: - Skills List

    private var skillsList: some View {
        List {
            ForEach(skillsStore.skills) { skill in
                NavigationLink {
                    SkillDetailView(skill: skill, skillsStore: skillsStore)
                } label: {
                    skillRow(skill)
                }
                .swipeActions(edge: .leading) {
                    if skill.state == "enabled" {
                        Button {
                            try? skillsStore.disableSkill(name: skill.name)
                            skillsStore.fetchSkills(force: true)
                        } label: {
                            Label { Text("Disable") } icon: { VIconView(.circlePlay, size: 12) }
                        }
                        .tint(.orange)
                    } else {
                        Button {
                            try? skillsStore.enableSkill(name: skill.name)
                            skillsStore.fetchSkills(force: true)
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
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)

                    stateBadge(skill.state)
                }

                if !skill.description.isEmpty {
                    Text(skill.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(2)
                }
            }

            Spacer()

            if skill.degraded {
                VIconView(.triangleAlert, size: 14)
                    .foregroundColor(.orange)
                    .accessibilityLabel("Degraded")
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Skill: \(skill.name), \(skill.state)\(skill.degraded ? ", degraded" : "")")
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

            Text("Browse the community to discover and install skills for your assistant.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No skills installed. Browse the community to discover and install skills for your assistant.")
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
