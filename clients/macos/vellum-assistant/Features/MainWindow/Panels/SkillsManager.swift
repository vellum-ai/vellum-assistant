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
    @ObservationIgnored private var categoryFingerprints: [String: String] = [:]
    var loadedBodies: [String: String] = [:]
    var isLoading = false
    var uninstallResult: SkillsStore.UninstallResult?
    var isUninstalling = false
    var selectedSkillFiles: SkillDetailFilesHTTPResponse?
    var isLoadingSkillFiles = false
    var skillFilesError: String?
    var loadedFileContents: [String: String] = [:]
    var loadingFilePaths: Set<String> = []
    var fileContentErrors: [String: String] = [:]
    var installingSkillId: String?
    var isSearching = false

    /// Safety timeout that defensively clears `installingSkillId` if a
    /// wedged `fetchSkills(force:)` response never lands. Without it, the
    /// install spinner can be stuck indefinitely when the confirmation
    /// refresh path is blocked or delayed.
    @ObservationIgnored private var installWatchdogTask: Task<Void, Never>?
    @ObservationIgnored private var searchDebounceTask: Task<Void, Never>?

    // MARK: - Filter Inputs

    var searchQuery: String = "" {
        didSet {
            dispatchSearch(query: searchQuery)
            recomputeFilteredData()
        }
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

                // Compute once — used for both isSearching gating and merge guard.
                let hasActiveQuery = !self.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

                // Gate spinner on whether there is actually a query; clearing
                // the search bar should immediately stop the spinner even if
                // a network request is still in-flight.
                self.isSearching = hasActiveQuery && self.skillsStore.isSearching

                // Merge local skills with external search results (if any),
                // deduplicating by skill id so local entries take precedence.
                let localSkills = self.skillsStore.skills
                let mergedSkills: [SkillInfo]
                if hasActiveQuery && !self.skillsStore.searchResults.isEmpty && !self.skillsStore.isSearching {
                    let localIds = Set(localSkills.map(\.id))
                    let externalResults = self.skillsStore.searchResults.filter { !localIds.contains($0.id) }
                    mergedSkills = localSkills + externalResults
                } else {
                    mergedSkills = localSkills
                }
                self.skills = mergedSkills
                self.rebuildCategoryMap(from: mergedSkills)
                self.loadedBodies = self.skillsStore.loadedBodies
                self.isLoading = self.skillsStore.isLoading
                self.uninstallResult = self.skillsStore.uninstallResult
                self.isUninstalling = self.skillsStore.isUninstalling
                self.selectedSkillFiles = self.skillsStore.selectedSkillFiles
                self.isLoadingSkillFiles = self.skillsStore.isLoadingSkillFiles
                self.skillFilesError = self.skillsStore.skillFilesError
                self.loadedFileContents = self.skillsStore.loadedFileContents
                self.loadingFilePaths = self.skillsStore.loadingFilePaths
                self.fileContentErrors = self.skillsStore.fileContentErrors
                if let result = self.skillsStore.installResult,
                   result.slug == self.installingSkillId {
                    if !result.success {
                        // Failure: release the spinner immediately so the
                        // Install button returns and the user can retry.
                        self.installingSkillId = nil
                        self.installWatchdogTask?.cancel()
                        self.installWatchdogTask = nil
                    } else if self.skillsStore.skills
                        .first(where: { $0.id == result.slug })?.kind != "catalog" {
                        // Success confirmed: the refreshed skills list has
                        // flipped the kind away from "catalog", so the
                        // detail view will render the installed UI on the
                        // next body pass without flicker.
                        self.installingSkillId = nil
                        self.installWatchdogTask?.cancel()
                        self.installWatchdogTask = nil
                    }
                    // Otherwise: keep the spinner up until fetchSkills(force:)
                    // lands — see `installSkill(slug:)` for the watchdog that
                    // clears the spinner defensively if the refresh wedges.
                }

                // Independent skills-list-driven clear: `SkillsStore.installSkill`
                // expires `installResult` after 3 seconds, so on a slow-network
                // install where `fetchSkills(force:)` lands after the expiry
                // the branch above will not fire — `installResult` is already
                // nil by the time the refreshed list arrives. Clear the
                // spinner here based solely on the skills list: if the
                // currently-installing id is now a non-catalog entry, the
                // install has confirmed and the spinner must come down.
                // `installingSkillId` is only set by `installSkill(slug:)`
                // for a catalog skill, so any transition away from "catalog"
                // for that id is a legitimate success signal. Idempotent
                // with the branch above: the `if let` guard short-circuits
                // when the first branch has already cleared the id.
                if let installingId = self.installingSkillId,
                   self.skillsStore.skills
                    .first(where: { $0.id == installingId })?.kind != "catalog" {
                    self.installingSkillId = nil
                    self.installWatchdogTask?.cancel()
                    self.installWatchdogTask = nil
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
        var fingerprints: [String: String] = [:]
        map.reserveCapacity(skills.count)
        fingerprints.reserveCapacity(skills.count)
        for skill in skills {
            let fp = skill.name + "\0" + skill.description
            if let cached = categoryMap[skill.id], categoryFingerprints[skill.id] == fp {
                map[skill.id] = cached
            } else {
                map[skill.id] = inferCategory(skill)
            }
            fingerprints[skill.id] = fp
        }
        categoryMap = map
        categoryFingerprints = fingerprints
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
            // When external search results have been merged in, the backend
            // already performed fuzzy/semantic matching — applying a local
            // substring filter would silently drop valid results whose query
            // text doesn't appear as a literal substring (e.g. skills.sh
            // results with empty descriptions). Skip the local filter in
            // that case and show the full merged list.
            let backendIds = Set(skillsStore.searchResults.map(\.id))
            let backendResultsPresent = !skillsStore.isSearching && baseSkills.contains(where: { backendIds.contains($0.id) })
            if backendResultsPresent {
                searchFiltered = baseSkills
            } else {
                searchFiltered = baseSkills.filter {
                    $0.name.lowercased().contains(query) ||
                    $0.description.lowercased().contains(query) ||
                    $0.id.lowercased().contains(query) ||
                    Self.sourceLabel($0.origin).lowercased().contains(query)
                }
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

    // MARK: - Debounced Search

    private func dispatchSearch(query: String) {
        searchDebounceTask?.cancel()
        // Always clear stale results immediately so previous search terms
        // don't linger during the debounce window or after clearing the bar.
        skillsStore.searchResults = []
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            isSearching = false
            return
        }
        // Show spinner immediately during the debounce window so the user
        // doesn't see the "No Skills Available" empty state for 300ms.
        isSearching = true
        searchDebounceTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            skillsStore.searchSkills(query: trimmed, force: true)
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

        // Defensive watchdog: a wedged `fetchSkills(force:)` response
        // after install would otherwise leave the spinner stuck forever.
        // Clear `installingSkillId` after 15 seconds if the confirmation
        // path has not already cleared it.
        installWatchdogTask?.cancel()
        installWatchdogTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard !Task.isCancelled else { return }
            guard let self else { return }
            if self.installingSkillId == slug {
                self.installingSkillId = nil
            }
        }
    }

    func fetchSkillFiles(skillId: String) {
        skillsStore.fetchSkillFiles(skillId: skillId)
    }

    func loadSkillFileContent(skillId: String, path: String) {
        skillsStore.loadSkillFileContent(skillId: skillId, path: path)
    }

    func clearLoadedFileContents() {
        skillsStore.clearLoadedFileContents()
    }

    func clearSkillDetail() {
        skillsStore.clearSkillDetail()
    }
}
