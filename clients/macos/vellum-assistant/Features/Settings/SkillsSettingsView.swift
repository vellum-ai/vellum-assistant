import SwiftUI
import VellumAssistantShared

// MARK: - View Model

@MainActor
final class SkillsSettingsViewModel: ObservableObject {
    @Published var skills: [SkillInfo] = []
    @Published var isLoading = false
    @Published var isUninstalling = false
    @Published var uninstallError: String?
    @Published var loadedBodies: [String: String] = [:]

    private let daemonClient: DaemonClient
    private var isOperationInProgress = false
    private var pendingOperations: [(name: String, enable: Bool)] = []

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func loadSkills() {
        guard !isLoading else { return }
        isLoading = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(SkillsListRequestMessage())
            } catch {
                isLoading = false
                return
            }

            for await message in stream {
                if case .skillsListResponse(let response) = message {
                    skills = response.skills
                    isLoading = false
                    return
                }
            }
            isLoading = false
        }
    }

    func toggleSkill(name: String, enable: Bool) {
        pendingOperations.append((name: name, enable: enable))
        processNextOperation()
    }

    func uninstallSkill(id: String) {
        guard !isUninstalling else { return }
        isUninstalling = true
        uninstallError = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.uninstallSkill(id)
            } catch {
                isUninstalling = false
                uninstallError = "Failed to connect"
                return
            }

            for await message in stream {
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "uninstall" {
                    if response.success {
                        skills.removeAll { $0.id == id }
                    } else {
                        uninstallError = response.error ?? "Uninstall failed"
                    }
                    isUninstalling = false
                    return
                }
            }
            isUninstalling = false
        }
    }

    func fetchSkillBody(skillId: String) {
        guard loadedBodies[skillId] == nil else { return }

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(SkillDetailRequestMessage(skillId: skillId))
            } catch {
                return
            }

            for await message in stream {
                if case .skillDetailResponse(let response) = message,
                   response.skillId == skillId {
                    if let error = response.error {
                        loadedBodies[skillId] = "Error: \(error)"
                    } else {
                        loadedBodies[skillId] = response.body
                    }
                    return
                }
            }
        }
    }

    private func processNextOperation() {
        guard !isOperationInProgress, let op = pendingOperations.first else { return }
        pendingOperations.removeFirst()
        isOperationInProgress = true

        Task {
            defer {
                isOperationInProgress = false
                processNextOperation()
            }

            let stream = daemonClient.subscribe()
            let operation = op.enable ? "enable" : "disable"
            let newState = op.enable ? "enabled" : "disabled"

            do {
                if op.enable {
                    try daemonClient.enableSkill(op.name)
                } else {
                    try daemonClient.disableSkill(op.name)
                }
            } catch {
                return
            }

            for await message in stream {
                if case .skillsOperationResponse(let response) = message,
                   response.operation == operation {
                    if response.success {
                        if let index = skills.firstIndex(where: { $0.name == op.name }) {
                            let updated = skills[index]
                            skills[index] = SkillInfo(
                                name: updated.name,
                                description: updated.description,
                                emoji: updated.emoji,
                                homepage: updated.homepage,
                                source: updated.source,
                                state: newState,
                                degraded: updated.degraded,
                                missingRequirements: updated.missingRequirements,
                                installedVersion: updated.installedVersion,
                                latestVersion: updated.latestVersion,
                                updateAvailable: updated.updateAvailable,
                                userInvocable: updated.userInvocable,
                                clawhub: updated.clawhub
                            )
                        }
                    }
                    return
                }
            }
        }
    }
}

// MARK: - Skills Settings View

struct SkillsSettingsView: View {
    @StateObject var viewModel: SkillsSettingsViewModel
    @Environment(\.dismiss) var dismiss
    @State private var searchText = ""
    @State private var skillToDelete: SkillInfo?
    @State private var inspectingSkill: SkillInfo?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Skills Manager")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            Divider()

            if viewModel.isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else {
                List {
                    // Managed skills section
                    if !managedSkills.isEmpty {
                        Section("Managed Skills") {
                            ForEach(managedSkills) { skill in
                                SkillRow(
                                    skill: skill,
                                    showActions: true,
                                    onToggle: { enabled in
                                        viewModel.toggleSkill(name: skill.name, enable: enabled)
                                    },
                                    onInspect: {
                                        inspectingSkill = skill
                                        viewModel.fetchSkillBody(skillId: skill.id)
                                    },
                                    onDelete: {
                                        skillToDelete = skill
                                    }
                                )
                            }
                        }
                    }

                    // Bundled skills section
                    if !bundledSkills.isEmpty {
                        Section("Bundled Skills") {
                            ForEach(bundledSkills) { skill in
                                SkillRow(
                                    skill: skill,
                                    onToggle: { enabled in
                                        viewModel.toggleSkill(name: skill.name, enable: enabled)
                                    }
                                )
                            }
                        }
                    }

                    // Workspace skills
                    if !workspaceSkills.isEmpty {
                        Section("Workspace Skills") {
                            ForEach(workspaceSkills) { skill in
                                SkillRow(
                                    skill: skill,
                                    onToggle: { enabled in
                                        viewModel.toggleSkill(name: skill.name, enable: enabled)
                                    }
                                )
                            }
                        }
                    }

                    // ClaWHub skills
                    if !clawhubSkills.isEmpty {
                        Section("ClaWHub Skills") {
                            ForEach(clawhubSkills) { skill in
                                SkillRow(
                                    skill: skill,
                                    onToggle: { enabled in
                                        viewModel.toggleSkill(name: skill.name, enable: enabled)
                                    }
                                )
                            }
                        }
                    }

                    // Extra skills
                    if !extraSkills.isEmpty {
                        Section("Extra Skills") {
                            ForEach(extraSkills) { skill in
                                SkillRow(
                                    skill: skill,
                                    onToggle: { enabled in
                                        viewModel.toggleSkill(name: skill.name, enable: enabled)
                                    }
                                )
                            }
                        }
                    }

                    // Show empty state only if no skills at all
                    if installedSkills.isEmpty {
                        Section("Installed Skills") {
                            Text("No skills installed")
                                .foregroundStyle(.secondary)
                        }
                    }

                    // Browse section (placeholder)
                    Section("Browse") {
                        TextField("Search skills...", text: $searchText)
                            .textFieldStyle(.roundedBorder)

                        HStack {
                            Image(systemName: "sparkles")
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("ClaWHub Integration Coming Soon")
                                    .font(VFont.headline)
                                Text("Browse and install community skills from the ClaWHub registry directly from Settings.")
                                    .font(VFont.body)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }

            // Uninstall error banner
            if let error = viewModel.uninstallError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(error)
                        .font(.caption)
                    Spacer()
                    Button("Dismiss") { viewModel.uninstallError = nil }
                        .font(.caption)
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(Color.orange.opacity(0.1))
            }
        }
        .frame(width: 520, height: 480)
        .onAppear {
            viewModel.loadSkills()
        }
        .alert("Delete Skill", isPresented: Binding(
            get: { skillToDelete != nil },
            set: { if !$0 { skillToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { skillToDelete = nil }
            Button("Delete", role: .destructive) {
                if let skill = skillToDelete {
                    viewModel.uninstallSkill(id: skill.id)
                    skillToDelete = nil
                }
            }
        } message: {
            if let skill = skillToDelete {
                Text("Are you sure you want to delete \"\(skill.name)\"? This will remove it from ~/.vellum/skills/.")
            }
        }
        .sheet(item: $inspectingSkill) { skill in
            SkillInspectSheet(
                skill: skill,
                skillBody: viewModel.loadedBodies[skill.id],
                onDismiss: { inspectingSkill = nil }
            )
        }
    }

    private var installedSkills: [SkillInfo] {
        viewModel.skills.filter { $0.source != "clawhub" || $0.state != "available" }
    }

    private var managedSkills: [SkillInfo] {
        installedSkills.filter { $0.source == "managed" }
    }

    private var bundledSkills: [SkillInfo] {
        installedSkills.filter { $0.source == "bundled" }
    }

    private var workspaceSkills: [SkillInfo] {
        installedSkills.filter { $0.source == "workspace" }
    }

    private var clawhubSkills: [SkillInfo] {
        installedSkills.filter { $0.source == "clawhub" }
    }

    private var extraSkills: [SkillInfo] {
        installedSkills.filter { $0.source == "extra" }
    }
}

// MARK: - Skill Inspect Sheet

private struct SkillInspectSheet: View {
    let skill: SkillInfo
    let skillBody: String?
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(skill.emoji ?? "🔧")
                    .font(.title2)
                Text(skill.name)
                    .font(.headline)
                Spacer()
                Button("Done") { onDismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            Divider()

            if let content = skillBody {
                ScrollView {
                    Text(content)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
            } else {
                Spacer()
                ProgressView("Loading skill body...")
                Spacer()
            }
        }
        .frame(width: 500, height: 400)
    }
}

// MARK: - Skill Row

private struct SkillRow: View {
    let skill: SkillInfo
    var showActions: Bool = false
    let onToggle: (Bool) -> Void
    var onInspect: (() -> Void)?
    var onDelete: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Emoji
            Text(skill.emoji ?? "🔧")
                .font(.title2)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name)
                    .font(VFont.headline)
                Text(skill.description)
                    .font(VFont.body)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                if skill.degraded, let missing = skill.missingRequirements {
                    degradedWarning(missing)
                }
            }

            Spacer()

            if showActions {
                HStack(spacing: 6) {
                    Button(action: { onInspect?() }) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 13))
                    }
                    .buttonStyle(.borderless)
                    .help("Inspect skill")

                    Button(action: { onDelete?() }) {
                        Image(systemName: "trash")
                            .font(.system(size: 13))
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.borderless)
                    .help("Delete skill")
                }
            }

            Toggle("", isOn: Binding(
                get: { skill.state == "enabled" },
                set: { newValue in onToggle(newValue) }
            ))
                .toggleStyle(.switch)
                .labelsHidden()
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func degradedWarning(_ missing: MissingRequirements) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)
                .font(.caption)

            Group {
                if let bins = missing.bins, !bins.isEmpty {
                    Text("Missing: \(bins.joined(separator: ", "))")
                } else if let env = missing.env, !env.isEmpty {
                    Text("Missing env: \(env.joined(separator: ", "))")
                } else if let perms = missing.permissions, !perms.isEmpty {
                    Text("Missing permissions: \(perms.joined(separator: ", "))")
                } else {
                    Text("Some requirements are not met")
                }
            }
            .font(.caption)
            .foregroundStyle(.orange)
        }
    }
}
