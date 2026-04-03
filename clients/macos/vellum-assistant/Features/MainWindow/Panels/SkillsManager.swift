import SwiftUI
import Combine
import VellumAssistantShared

/// Filter for showing skills by status or source.
enum SkillFilter: String, CaseIterable {
    case all = "All"
    case installed = "Installed"
    case available = "Available"
    case vellum = "Vellum"
    case community = "Community"
    case custom = "Custom"

    var icon: VIcon {
        switch self {
        case .all: return .layoutGrid
        case .installed: return .circleCheck
        case .available: return .arrowDownToLine
        case .vellum: return .package
        case .community: return .globe
        case .custom: return .user
        }
    }

    static var statusFilters: [SkillFilter] { [.all, .installed, .available] }
    static var sourceFilters: [SkillFilter] { [.vellum, .community, .custom] }
}

@MainActor
@Observable
final class SkillsManager {
    let skillsStore: SkillsStore

    // Forward all published properties from SkillsStore so existing views
    // continue to work via observation on SkillsManager unchanged.
    var skills: [SkillInfo] = []
    /// Cached skill-id -> category map, rebuilt whenever `skills` changes.
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

    // MARK: - Filter Inputs

    var searchQuery: String = "" {
        didSet { recomputeFilteredData() }
    }

    var selectedCategory: SkillCategory? {
        didSet { recomputeFilteredData() }
    }

    var skillFilter: SkillFilter = .all {
        didSet { recomputeFilteredData() }
    }

    // MARK: - Cached Derived Data (O(1) reads from views)

    /// Skills filtered by search + category + skill filter, sorted for display.
    private(set) var filteredSkills: [SkillInfo] = []

    /// Per-category counts based on the current search + skill filter (excludes category filter).
    private(set) var categoryCounts: [SkillCategory: Int] = [:]

    /// Total count of skills matching search + skill filter (the "All" count).
    private(set) var searchFilteredCount: Int = 0

    /// Whether the base skills (after skill filter, before search/category) are empty.
    private(set) var baseSkillsEmpty: Bool = true

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
                self.recomputeFilteredData()
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

    // MARK: - Recomputation

    /// Single-pass O(N) recomputation of all derived data.
    /// Called whenever any filter input or the underlying skills list changes.
    private func recomputeFilteredData() {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hasSearch = !query.isEmpty

        let baseSkills: [SkillInfo]
        switch skillFilter {
        case .all:
            baseSkills = skills
        case .installed:
            baseSkills = skills.filter { $0.isInstalled }
        case .available:
            baseSkills = skills.filter { $0.isAvailable }
        case .vellum:
            baseSkills = skills.filter { $0.origin == "vellum" }
        case .community:
            baseSkills = skills.filter { $0.origin == "clawhub" || $0.origin == "skillssh" }
        case .custom:
            baseSkills = skills.filter { $0.origin == "custom" }
        }

        let searchFiltered: [SkillInfo]
        if hasSearch {
            searchFiltered = baseSkills.filter {
                $0.name.lowercased().contains(query) ||
                $0.description.lowercased().contains(query) ||
                $0.id.lowercased().contains(query) ||
                Self.sourceLabel($0.origin).lowercased().contains(query)
            }
        } else {
            searchFiltered = baseSkills
        }

        var counts: [SkillCategory: Int] = [:]
        for skill in searchFiltered {
            let cat = category(for: skill)
            counts[cat, default: 0] += 1
        }
        categoryCounts = counts
        searchFilteredCount = searchFiltered.count
        baseSkillsEmpty = baseSkills.isEmpty

        let categoryFiltered: [SkillInfo]
        if let category = selectedCategory {
            categoryFiltered = searchFiltered.filter { self.category(for: $0) == category }
        } else {
            categoryFiltered = searchFiltered
        }

        filteredSkills = categoryFiltered.sorted { a, b in
            if a.isInstalled != b.isInstalled { return a.isInstalled }
            let aCommunity = (a.origin == "clawhub" || a.origin == "skillssh")
            let bCommunity = (b.origin == "clawhub" || b.origin == "skillssh")
            if a.isInstalled && b.isInstalled && aCommunity != bCommunity { return aCommunity }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    // MARK: - Helpers

    /// Human-readable label for a skill origin.
    static func sourceLabel(_ origin: String) -> String {
        switch origin {
        case "vellum":
            return "Vellum"
        case "clawhub":
            return "Community"
        case "skillssh":
            return "Community"
        case "custom":
            return "Custom"
        default:
            return origin.replacingOccurrences(of: "-", with: " ").capitalized
        }
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
