import SwiftUI
import Combine
import VellumAssistantShared

@MainActor
final class SkillsManager: ObservableObject {
    let skillsStore: SkillsStore

    // Forward all published properties from SkillsStore so existing views
    // continue to work via @ObservedObject on SkillsManager unchanged.
    @Published var skills: [SkillInfo] = []
    @Published var loadedBodies: [String: String] = [:]
    @Published var isLoading = false
    @Published var uninstallResult: SkillsStore.UninstallResult?
    @Published var isUninstalling = false

    // Kept for source compatibility with existing macOS views.
    typealias UninstallResult = SkillsStore.UninstallResult

    init(daemonClient: DaemonClient) {
        self.skillsStore = SkillsStore(daemonClient: daemonClient)
        bindStore()
    }

    /// Wire up Combine subscriptions to forward SkillsStore state.
    private func bindStore() {
        skillsStore.$skills.assign(to: &$skills)
        skillsStore.$loadedBodies.assign(to: &$loadedBodies)
        skillsStore.$isLoading.assign(to: &$isLoading)
        skillsStore.$uninstallResult.assign(to: &$uninstallResult)
        skillsStore.$isUninstalling.assign(to: &$isUninstalling)
    }

    // MARK: - Delegated Operations

    func fetchSkills(force: Bool = false) {
        skillsStore.fetchSkills(force: force)
    }

    func fetchSkillBody(skillId: String) {
        skillsStore.fetchSkillBody(skillId: skillId)
    }

    func uninstallSkill(id: String) {
        skillsStore.uninstallSkill(id: id)
    }
}
