import Foundation
import VellumAssistantShared

/// State management for the command palette (CMD+K).
@MainActor
@Observable
final class CommandPaletteViewModel {
    var query = ""
    var selectedIndex = 0
    var isSearching = false

    /// Static actions (set once at palette creation).
    var actions: [CommandPaletteAction] = []

    /// Recent conversations (set once at palette creation from ConversationManager).
    var recentItems: [CommandPaletteRecentItem] = []

    /// Server search results populated from the global search API.
    var serverResults = GlobalSearchResults.empty

    /// Debounce task for search queries.
    private var searchTask: Task<Void, Never>?

    /// Filtered actions based on the current query.
    var filteredActions: [CommandPaletteAction] {
        guard !query.isEmpty else { return actions }
        let q = query.lowercased()
        return actions.filter { $0.label.lowercased().contains(q) }
    }

    /// Filtered recent items based on the current query.
    var filteredRecents: [CommandPaletteRecentItem] {
        guard !query.isEmpty else { return recentItems }
        let q = query.lowercased()
        return recentItems.filter { $0.title.lowercased().contains(q) }
    }

    /// All visible items in display order (actions, recents, then server results by category).
    var allItems: [CommandPaletteItem] {
        var items: [CommandPaletteItem] = []
        items += filteredActions.map { .action($0) }
        items += filteredRecents.map { .recent($0) }
        items += serverResults.conversations.map { .conversation($0) }
        items += serverResults.schedules.map { .schedule($0) }
        items += serverResults.contacts.map { .contact($0) }
        return items
    }

    /// Total count of visible items.
    var totalItemCount: Int {
        allItems.count
    }

    /// Whether there are any server results to display.
    var hasServerResults: Bool {
        !serverResults.conversations.isEmpty ||
        !serverResults.schedules.isEmpty ||
        !serverResults.contacts.isEmpty
    }

    /// Resets state for a fresh palette opening.
    func reset() {
        query = ""
        selectedIndex = 0
        isSearching = false
        serverResults = .empty
        searchTask?.cancel()
        searchTask = nil
    }

    func moveSelectionUp() {
        if selectedIndex > 0 {
            selectedIndex -= 1
        }
    }

    func moveSelectionDown() {
        if selectedIndex < totalItemCount - 1 {
            selectedIndex += 1
        }
    }

    /// Clamps the selection index to valid bounds after filtering changes.
    func clampSelection() {
        let maxIndex = max(0, totalItemCount - 1)
        if selectedIndex > maxIndex {
            selectedIndex = maxIndex
        }
    }

    // MARK: - Server Search

    /// Triggers a debounced server search. Call this when the query changes.
    func triggerSearch() {
        searchTask?.cancel()

        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            serverResults = .empty
            isSearching = false
            return
        }

        isSearching = true

        searchTask = Task { [weak self] in
            // 150ms debounce
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }

            guard let self else { return }
            let results = await self.performSearch(query: trimmed)

            guard !Task.isCancelled else { return }
            self.serverResults = results
            self.isSearching = false
            self.clampSelection()
        }
    }

    private func performSearch(query: String) async -> GlobalSearchResults {
        let params = ["q": query, "limit": "10", "categories": "conversations,schedules,contacts"]

        do {
            let (decoded, response): (GlobalSearchResponse?, _) = try await GatewayHTTPClient.get(
                path: "search/global",
                params: params,
                timeout: 5
            )
            guard response.isSuccess, let decoded else {
                return .empty
            }
            return decoded.results
        } catch {
            return .empty
        }
    }
}
