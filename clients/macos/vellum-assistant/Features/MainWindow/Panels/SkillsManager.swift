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

    /// Wire up a single Combine subscription to forward SkillsStore state.
    ///
    /// Uses `objectWillChange` so that all `@Published` mutations within a
    /// single run-loop tick are coalesced into one observation notification,
    /// avoiding the cascading view updates caused by per-property sinks.
    private func bindStore() {
        skillsStore.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                let skills = self.skillsStore.skills
                self.skills = skills
                self.rebuildCategoryMap(from: skills)
                self.loadedBodies = self.skillsStore.loadedBodies
                self.isLoading = self.skillsStore.isLoading
                self.uninstallResult = self.skillsStore.uninstallResult
                self.isUninstalling = self.skillsStore.isUninstalling
                self.selectedSkillFiles = self.skillsStore.selectedSkillFiles
                self.isLoadingSkillFiles = self.skillsStore.isLoadingSkillFiles
                self.skillFilesError = self.skillsStore.skillFilesError
                if let result = self.skillsStore.installResult,
                   result.slug == self.installingSkillId {
                    self.installingSkillId = nil
                }
            }
            .store(in: &cancellables)
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
