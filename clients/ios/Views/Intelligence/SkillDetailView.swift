#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SkillDetailView: View {
    let skill: SkillInfo
    @ObservedObject var skillsStore: SkillsStore
    @State private var showUninstallConfirmation = false
    @State private var expandedFilePath: String?
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
                    detailRow(label: "Stars", value: "\(clawhub.stars)")
                } else if let skillssh = skill.skillssh {
                    detailRow(label: "Source Repo", value: skillssh.sourceRepo)
                }
                detailRow(label: "Origin", value: originLabel(skill.origin))
                detailRow(label: "Status", value: skill.status.capitalized)
            }

            // Inspect data section (loaded from ClaWHub)
            if let inspected = skillsStore.inspectedSkill {
                Section("About") {
                    if !inspected.skill.summary.isEmpty {
                        Text(inspected.skill.summary)
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentSecondary)
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
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                                Text(changelog)
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentSecondary)
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
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(.red)
                }
            }

            // Actions section
            Section {
                if isInstalled {
                    // Enable/Disable toggle
                    Button {
                        if skill.isEnabled {
                            skillsStore.disableSkill(name: skill.name)
                        } else {
                            skillsStore.enableSkill(name: skill.name)
                        }
                    } label: {
                        HStack {
                            VIconView(.circlePlay, size: 16)
                            Text(skill.isEnabled ? "Disable Skill" : "Enable Skill")
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

            // Files section
            if skillsStore.isLoadingSkillFiles {
                Section("Files") {
                    HStack {
                        Spacer()
                        ProgressView()
                            .padding()
                        Spacer()
                    }
                }
            } else if let error = skillsStore.skillFilesError {
                Section("Files") {
                    Text(error)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(.red)
                }
            } else if let filesResponse = skillsStore.selectedSkillFiles, !filesResponse.files.isEmpty {
                Section("Files") {
                    ForEach(filesResponse.files, id: \.path) { file in
                        fileRow(file)
                    }
                }
            }
        }
        .navigationTitle(skill.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Inspect the skill if it has a clawhub origin
            if skill.clawhub != nil {
                skillsStore.inspectSkill(slug: skill.id)
            }
            skillsStore.fetchSkillFiles(skillId: skill.id)
        }
        .onDisappear {
            skillsStore.clearInspection()
            skillsStore.clearSkillDetail()
            expandedFilePath = nil
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
            Text(skill.vellum?.emoji ?? "")
                .font(.system(size: 48))
                .accessibilityHidden(true)

            Text(skill.name)
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            if !skill.description.isEmpty {
                Text(skill.description)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
            }

            VSkillTypePill(origin: skill.origin, status: skill.status)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Detail Row

    private func detailRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            Spacer()
            Text(value)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    // MARK: - File Row

    @ViewBuilder
    private func fileRow(_ file: SkillFileEntry) -> some View {
        let isText = !file.isBinary && file.content != nil
        let isExpanded = expandedFilePath == file.path

        VStack(alignment: .leading, spacing: 0) {
            Button {
                if isText {
                    withAnimation {
                        expandedFilePath = isExpanded ? nil : file.path
                    }
                }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    VIconView(fileIcon(for: file.mimeType, fileName: file.name), size: 16)
                        .foregroundStyle(VColor.primaryBase)
                        .frame(width: 24)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(file.path)
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                            .lineLimit(1)

                        Text(formatFileSize(file.size))
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }

                    Spacer()

                    if isText {
                        VIconView(isExpanded ? .chevronUp : .chevronDown, size: 12)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!isText)

            if isExpanded, let content = file.content {
                Text(content)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .textSelection(.enabled)
                    .padding(VSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VColor.surfaceBase)
                    .cornerRadius(VRadius.sm)
                    .padding(.top, VSpacing.xs)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(file.path), \(formatFileSize(file.size))\(file.isBinary ? ", binary" : "")")
    }

    // MARK: - Origin Label

    private func originLabel(_ origin: String) -> String {
        switch origin {
        case "vellum": return "Core"
        case "clawhub": return "Community"
        case "skillssh": return "Community"
        case "custom": return "Created"
        default: return origin.capitalized
        }
    }

    // MARK: - File Helpers

    private func fileIcon(for mimeType: String, fileName: String? = nil) -> VIcon {
        if mimeType.hasPrefix("image/") { return .image }
        if mimeType.hasPrefix("video/") { return .video }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/json" || mimeType == "application/javascript" || mimeType == "application/typescript" { return .fileCode }
        if let name = fileName, FileExtensions.isCode(name) { return .fileCode }
        return .file
    }
}
#endif
