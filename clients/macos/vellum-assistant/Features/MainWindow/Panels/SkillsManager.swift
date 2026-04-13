import SwiftUI
import Combine
import VellumAssistantShared

/// Filter for showing skills by status or source.
enum SkillFilter: String, CaseIterable {
    case all = "All"
    case installed = "Installed"
    case available = "Available"
    case vellum = "Vellum"
    case clawhub = "Clawhub"
    case skillssh = "skills.sh"
    case custom = "Custom"

    var icon: VIcon {
        switch self {
        case .all: return .layoutGrid
        case .installed: return .circleCheck
        case .available: return .arrowDownToLine
        case .vellum: return .package
        case .clawhub: return .globe
        case .skillssh: return .terminal
        case .custom: return .user
        }
    }

    static var statusFilters: [SkillFilter] { [.all, .installed, .available] }
    static var sourceFilters: [SkillFilter] { [.vellum, .clawhub, .skillssh, .custom] }
}

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
        }
    }

    var selectedCategory: SkillCategory? {
        didSet { fetchFilteredSkills() }
    }

    var skillFilter: SkillFilter = .all {
        didSet { fetchFilteredSkills() }
    }

    // MARK: - Cached Derived Data (O(1) reads from views)

    /// Skills filtered by search + category + skill filter, sorted for display.
    private(set) var filteredSkills: [SkillInfo] = []

    /// Per-category counts from the server response, keyed by category raw value.
    private(set) var categoryCounts: [SkillCategory: Int] = [:]

    /// Total count of skills matching the current filters (from server response).
    private(set) var searchFilteredCount: Int = 0

    /// Whether the current filtered skills list is empty.
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
                let debouncing = self.searchDebounceTask != nil && !(self.searchDebounceTask?.isCancelled ?? true)
                self.isSearching = hasActiveQuery && (self.skillsStore.isSearching || debouncing)

                // Merge local skills with external search results (if any),
                // deduplicating by skill id so local entries take precedence.
                // The merge is kept active while `isSearching` so that skills
                // from the previous search remain visible (e.g. when a user
                // clicks into a search result's detail view while a re-search
                // is in progress). `searchResults` is only cleared on query
                // changes (via `cancelSearch`), so stale cross-query results
                // are already handled.
                let localSkills = self.skillsStore.skills
                let mergedSkills: [SkillInfo]
                if hasActiveQuery && !self.skillsStore.searchResults.isEmpty {
                    let localIds = Set(localSkills.map(\.id))
                    let externalResults = self.skillsStore.searchResults.filter { !localIds.contains($0.id) }
                    mergedSkills = localSkills + externalResults
                } else {
                    mergedSkills = localSkills
                }
                self.skills = mergedSkills
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

    // MARK: - Server-Side Filtered Fetch

    /// Translates the current filter state into API params and triggers a server-side
    /// filtered fetch. Called when the filter dropdown, category, or search query changes.
    private func fetchFilteredSkills() {
        let originParam: String? = {
            switch skillFilter {
            case .vellum: return "vellum"
            case .clawhub: return "clawhub"
            case .skillssh: return "skillssh"
            case .custom: return "custom"
            default: return nil
            }
        }()
        let kindParam: String? = {
            switch skillFilter {
            case .installed: return "installed"
            case .available: return "available"
            default: return nil
            }
        }()
        let queryParam = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let categoryParam = selectedCategory?.rawValue

        skillsStore.fetchSkills(force: true, origin: originParam, kind: kindParam, query: queryParam.isEmpty ? nil : queryParam, category: categoryParam)
    }

    // MARK: - Recomputation

    /// Recompute derived display data from server-filtered skills.
    /// Origin, kind, text search, and category filtering are now server-side.
    /// This method merges external search results, updates category counts
    /// from the server response, and applies display sorting.
    private func recomputeFilteredData() {
        // Convert server-provided category counts (String keys) to SkillCategory keys.
        var counts: [SkillCategory: Int] = [:]
        for (key, value) in skillsStore.categoryCounts {
            if let cat = SkillCategory(rawValue: key) {
                counts[cat] = value
            }
        }
        categoryCounts = counts
        searchFilteredCount = skillsStore.totalCount
        baseSkillsEmpty = skills.isEmpty

        // Sort for display: installed first, community origins before core, alphabetical.
        filteredSkills = skills.sorted { a, b in
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
            return "Clawhub"
        case "skillssh":
            return "skills.sh"
        case "custom":
            return "Custom"
        default:
            return origin.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    // MARK: - Debounced Search

    private func dispatchSearch(query: String) {
        searchDebounceTask?.cancel()
        // Cancel any in-flight network search and clear stale results
        // immediately so previous search terms don't linger during the
        // debounce window or after clearing the bar.
        skillsStore.cancelSearch()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            isSearching = false
            // Re-fetch with current filters but no query to reset the list.
            fetchFilteredSkills()
            return
        }
        // Show spinner immediately during the debounce window so the user
        // doesn't see the "No Skills Available" empty state for 300ms.
        isSearching = true
        searchDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            // Trigger both the external registry search and the server-side
            // filtered fetch with the query param in parallel.
            self?.skillsStore.searchSkills(query: trimmed, force: true)
            self?.fetchFilteredSkills()
            self?.searchDebounceTask = nil
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
