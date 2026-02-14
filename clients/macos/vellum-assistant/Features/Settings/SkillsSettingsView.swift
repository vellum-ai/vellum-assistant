import SwiftUI
import VellumAssistantShared

// MARK: - View Model

@MainActor
final class SkillsSettingsViewModel: ObservableObject {
    @Published var skills: [SkillInfo] = []
    @Published var isLoading = false

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
                    // Enabled Skills section
                    Section("Installed Skills") {
                        if installedSkills.isEmpty {
                            Text("No skills installed")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(installedSkills) { skill in
                                SkillRow(
                                    skill: skill,
                                    onToggle: { enabled in
                                        viewModel.toggleSkill(name: skill.name, enable: enabled)
                                    }
                                )
                            }
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
        }
        .frame(width: 520, height: 480)
        .onAppear {
            viewModel.loadSkills()
        }
    }

    private var installedSkills: [SkillInfo] {
        viewModel.skills.filter { $0.source != "clawhub" || $0.state != "available" }
    }
}

// MARK: - Skill Row

private struct SkillRow: View {
    let skill: SkillInfo
    let onToggle: (Bool) -> Void

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
