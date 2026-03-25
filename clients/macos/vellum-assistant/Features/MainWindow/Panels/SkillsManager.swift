import SwiftUI
import Combine
import VellumAssistantShared

@MainActor
@Observable
final class SkillsManager {
    let skillsStore: SkillsStore

    // Forward all published properties from SkillsStore so existing views
    // continue to work via observation on SkillsManager unchanged.
    var skills: [SkillInfo] = []
    var loadedBodies: [String: String] = [:]
    var isLoading = false
    var uninstallResult: SkillsStore.UninstallResult?
    var isUninstalling = false
    var selectedSkillFiles: SkillDetailFilesHTTPResponse?
    var isLoadingSkillFiles = false
    var skillFilesError: String?

    // Draft / create state
    var isDrafting = false
    var draftResult: SkillsStore.SkillDraftResult?
    var draftError: String?
    var isCreating = false
    var createError: String?

    @ObservationIgnored private var cancellables = Set<AnyCancellable>()

    // Kept for source compatibility with existing macOS views.
    typealias UninstallResult = SkillsStore.UninstallResult

    init(connectionManager: GatewayConnectionManager) {
        self.skillsStore = SkillsStore()
        bindStore()
    }

    /// Wire up Combine subscriptions to forward SkillsStore state.
    private func bindStore() {
        skillsStore.$skills.sink { [weak self] in self?.skills = $0 }.store(in: &cancellables)
        skillsStore.$loadedBodies.sink { [weak self] in self?.loadedBodies = $0 }.store(in: &cancellables)
        skillsStore.$isLoading.sink { [weak self] in self?.isLoading = $0 }.store(in: &cancellables)
        skillsStore.$uninstallResult.sink { [weak self] in self?.uninstallResult = $0 }.store(in: &cancellables)
        skillsStore.$isUninstalling.sink { [weak self] in self?.isUninstalling = $0 }.store(in: &cancellables)
        skillsStore.$selectedSkillFiles.sink { [weak self] in self?.selectedSkillFiles = $0 }.store(in: &cancellables)
        skillsStore.$isLoadingSkillFiles.sink { [weak self] in self?.isLoadingSkillFiles = $0 }.store(in: &cancellables)
        skillsStore.$skillFilesError.sink { [weak self] in self?.skillFilesError = $0 }.store(in: &cancellables)
        skillsStore.$isDrafting.sink { [weak self] in self?.isDrafting = $0 }.store(in: &cancellables)
        skillsStore.$draftResult.sink { [weak self] in self?.draftResult = $0 }.store(in: &cancellables)
        skillsStore.$draftError.sink { [weak self] in self?.draftError = $0 }.store(in: &cancellables)
        skillsStore.$isCreating.sink { [weak self] in self?.isCreating = $0 }.store(in: &cancellables)
        skillsStore.$createError.sink { [weak self] in self?.createError = $0 }.store(in: &cancellables)
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

    func fetchSkillFiles(skillId: String) {
        skillsStore.fetchSkillFiles(skillId: skillId)
    }

    func clearSkillDetail() {
        skillsStore.clearSkillDetail()
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
