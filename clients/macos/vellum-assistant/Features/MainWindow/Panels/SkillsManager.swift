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
    @Published var searchResults: [ClawhubSkillItem] = []
    @Published var isSearching = false
    @Published var inspectedSkill: ClawhubInspectData?
    @Published var isInspecting = false
    @Published var inspectError: String?
    @Published var installResult: SkillsStore.InstallResult?
    @Published var uninstallResult: SkillsStore.UninstallResult?
    @Published var isUninstalling = false
    @Published var draftResult: SkillsStore.SkillDraftResult?
    @Published var isDrafting = false
    @Published var draftError: String?
    @Published var isCreating = false
    @Published var createError: String?

    // Kept for source compatibility with existing macOS views.
    typealias InstallResult = SkillsStore.InstallResult
    typealias UninstallResult = SkillsStore.UninstallResult
    typealias SkillDraftResult = SkillsStore.SkillDraftResult

    init(daemonClient: DaemonClient) {
        self.skillsStore = SkillsStore(daemonClient: daemonClient)
        bindStore()
    }

    /// Wire up Combine subscriptions to forward SkillsStore state.
    private func bindStore() {
        skillsStore.$skills.assign(to: &$skills)
        skillsStore.$loadedBodies.assign(to: &$loadedBodies)
        skillsStore.$isLoading.assign(to: &$isLoading)
        skillsStore.$searchResults.assign(to: &$searchResults)
        skillsStore.$isSearching.assign(to: &$isSearching)
        skillsStore.$inspectedSkill.assign(to: &$inspectedSkill)
        skillsStore.$isInspecting.assign(to: &$isInspecting)
        skillsStore.$inspectError.assign(to: &$inspectError)
        skillsStore.$installResult.assign(to: &$installResult)
        skillsStore.$uninstallResult.assign(to: &$uninstallResult)
        skillsStore.$isUninstalling.assign(to: &$isUninstalling)
        skillsStore.$draftResult.assign(to: &$draftResult)
        skillsStore.$isDrafting.assign(to: &$isDrafting)
        skillsStore.$draftError.assign(to: &$draftError)
        skillsStore.$isCreating.assign(to: &$isCreating)
        skillsStore.$createError.assign(to: &$createError)
    }

    // MARK: - Delegated Operations

    func fetchSkills(force: Bool = false) {
        skillsStore.fetchSkills(force: force)
    }

    func fetchSkillBody(skillId: String) {
        skillsStore.fetchSkillBody(skillId: skillId)
    }

    func searchSkills(query: String = "", force: Bool = false) {
        skillsStore.searchSkills(query: query, force: force)
    }

    func installSkill(slug: String) {
        skillsStore.installSkill(slug: slug)
    }

    func inspectSkill(slug: String) {
        skillsStore.inspectSkill(slug: slug)
    }

    func uninstallSkill(id: String) {
        skillsStore.uninstallSkill(id: id)
    }

    func clearInspection() {
        skillsStore.clearInspection()
    }

    func draftSkill(sourceText: String) {
        skillsStore.draftSkill(sourceText: sourceText)
    }

    func createSkillFromDraft(skillId: String, name: String, description: String, emoji: String?, bodyMarkdown: String) {
        skillsStore.createSkillFromDraft(skillId: skillId, name: name, description: description, emoji: emoji, bodyMarkdown: bodyMarkdown)
    }

    func resetDraftState() {
        skillsStore.resetDraftState()
    }
}
