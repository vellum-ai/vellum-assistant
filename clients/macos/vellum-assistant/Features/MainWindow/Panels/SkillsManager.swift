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
    /// Cached skill-id → category map, rebuilt whenever `skills` changes.
    /// Use `category(for:)` for O(1) lookups instead of calling `inferCategory` in view bodies.
    private(set) var categoryMap: [String: SkillCategory] = [:]
    var loadedBodies: [String: String] = [:]
    var isLoading = false
    var uninstallResult: SkillsStore.UninstallResult?
    var isUninstalling = false
    var selectedSkillFiles: SkillDetailFilesHTTPResponse?
    var isLoadingSkillFiles = false
    var skillFilesError: String?
    var installingSkillId: String?

    @ObservationIgnored private var cancellables = Set<AnyCancellable>()

    // Kept for source compatibility with existing macOS views.
    typealias UninstallResult = SkillsStore.UninstallResult

    init(connectionManager: GatewayConnectionManager) {
        self.skillsStore = SkillsStore()
        bindStore()
    }

    /// Wire up Combine subscriptions to forward SkillsStore state.
    private func bindStore() {
        skillsStore.$skills.sink { [weak self] skills in
            guard let self else { return }
            self.skills = skills
            self.rebuildCategoryMap(from: skills)
        }.store(in: &cancellables)
        skillsStore.$loadedBodies.sink { [weak self] in self?.loadedBodies = $0 }.store(in: &cancellables)
        skillsStore.$isLoading.sink { [weak self] in self?.isLoading = $0 }.store(in: &cancellables)
        skillsStore.$uninstallResult.sink { [weak self] in self?.uninstallResult = $0 }.store(in: &cancellables)
        skillsStore.$isUninstalling.sink { [weak self] in self?.isUninstalling = $0 }.store(in: &cancellables)
        skillsStore.$selectedSkillFiles.sink { [weak self] in self?.selectedSkillFiles = $0 }.store(in: &cancellables)
        skillsStore.$isLoadingSkillFiles.sink { [weak self] in self?.isLoadingSkillFiles = $0 }.store(in: &cancellables)
        skillsStore.$skillFilesError.sink { [weak self] in self?.skillFilesError = $0 }.store(in: &cancellables)
        skillsStore.$installResult.sink { [weak self] result in
            guard let self, let result else { return }
            guard result.slug == self.installingSkillId else { return }
            self.installingSkillId = nil
        }.store(in: &cancellables)
    }

    // MARK: - Category Lookup

    /// O(1) category lookup for a skill. Falls back to `.knowledge` for unknown IDs.
    func category(for skill: SkillInfo) -> SkillCategory {
        categoryMap[skill.id] ?? .knowledge
    }

    private func rebuildCategoryMap(from skills: [SkillInfo]) {
        var map: [String: SkillCategory] = [:]
        map.reserveCapacity(skills.count)
        for skill in skills {
            map[skill.id] = inferCategory(skill)
        }
        categoryMap = map
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

    func installSkill(slug: String) {
        installingSkillId = slug
        skillsStore.installSkill(slug: slug)
    }

    func fetchSkillFiles(skillId: String) {
        skillsStore.fetchSkillFiles(skillId: skillId)
    }

    func clearSkillDetail() {
        skillsStore.clearSkillDetail()
    }
}
