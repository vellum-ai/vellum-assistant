#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SkillDetailView: View {
    let skill: SkillInfo
    @ObservedObject var skillsStore: SkillsStore
    @State private var showUninstallConfirmation = false
    @Environment(\.dismiss) private var dismiss

    /// Whether this skill is currently installed (present in the installed skills list).
    private var isInstalled: Bool {
        skillsStore.skills.contains { $0.id == skill.id }
    }

    var body: some View {
        List {
            // Header section
            Section {
                headerSection
            }

            // Details section
            Section("Details") {
                if let clawhub = skill.clawhub {
                    detailRow(label: "Author", value: clawhub.author)
                }
                if let version = skill.installedVersion {
                    detailRow(label: "Version", value: version)
                }
                detailRow(label: "Source", value: skill.source.capitalized)
                detailRow(label: "State", value: skill.state.capitalized)

                if let provenance = skill.provenance {
                    detailRow(label: "Provenance", value: provenance.kind.capitalized)
                    if let provider = provenance.provider {
                        detailRow(label: "Provider", value: provider)
                    }
                }
            }

            // Inspect data section (loaded from ClaWHub)
            if let inspected = skillsStore.inspectedSkill {
                Section("About") {
                    if !inspected.skill.summary.isEmpty {
                        Text(inspected.skill.summary)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }

                    if let owner = inspected.owner {
                        detailRow(label: "Owner", value: owner.displayName)
                    }

                    if let stats = inspected.stats {
                        detailRow(label: "Stars", value: "\(stats.stars)")
                        detailRow(label: "Installs", value: "\(stats.installs)")
                    }

                    if let latestVersion = inspected.latestVersion {
                        detailRow(label: "Latest Version", value: latestVersion.version)
                        if let changelog = latestVersion.changelog, !changelog.isEmpty {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Changelog")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                                Text(changelog)
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                            }
                        }
                    }
                }
            } else if skillsStore.isInspecting {
                Section("About") {
                    HStack {
                        Spacer()
                        ProgressView()
                            .padding()
                        Spacer()
                    }
                }
            } else if let error = skillsStore.inspectError {
                Section("About") {
                    Text(error)
                        .font(VFont.body)
                        .foregroundColor(.red)
                }
            }

            // Actions section
            Section {
                if isInstalled {
                    // Enable/Disable toggle
                    Button {
                        do {
                            if skill.state == "enabled" {
                                try skillsStore.disableSkill(name: skill.name)
                            } else {
                                try skillsStore.enableSkill(name: skill.name)
                            }
                            skillsStore.fetchSkills(force: true)
                        } catch {
                            // Silently fail — the store handles errors
                        }
                    } label: {
                        HStack {
                            VIconView(.circlePlay, size: 16)
                            Text(skill.state == "enabled" ? "Disable Skill" : "Enable Skill")
                        }
                    }

                    // Uninstall
                    Button(role: .destructive) {
                        showUninstallConfirmation = true
                    } label: {
                        HStack {
                            VIconView(.trash, size: 16)
                            Text("Uninstall Skill")
                        }
                    }
                } else {
                    // Install
                    Button {
                        skillsStore.installSkill(slug: skill.id)
                    } label: {
                        HStack {
                            VIconView(.arrowDown, size: 16)
                            Text("Install Skill")
                        }
                    }
                }
            }
        }
        .navigationTitle(skill.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Inspect the skill if it has a clawhub source
            if skill.clawhub != nil {
                skillsStore.inspectSkill(slug: skill.id)
            }
        }
        .onDisappear {
            skillsStore.clearInspection()
        }
        .alert("Uninstall Skill", isPresented: $showUninstallConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Uninstall", role: .destructive) {
                skillsStore.uninstallSkill(id: skill.id)
                dismiss()
            }
        } message: {
            Text("Are you sure you want to uninstall \"\(skill.name)\"? This action cannot be undone.")
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: VSpacing.sm) {
            Text(skill.emoji ?? "")
                .font(.system(size: 48))
                .accessibilityHidden(true)

            Text(skill.name)
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            if !skill.description.isEmpty {
                Text(skill.description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }

            if skill.degraded {
                HStack(spacing: 4) {
                    VIconView(.triangleAlert, size: 12)
                    Text("Degraded")
                        .font(VFont.caption)
                }
                .foregroundColor(.orange)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Skill is degraded")
            }

            if skill.updateAvailable {
                HStack(spacing: 4) {
                    VIconView(.circleArrowUp, size: 12)
                    Text("Update available")
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.accent)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Update available for this skill")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Detail Row

    private func detailRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            Spacer()
            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}
#endif
