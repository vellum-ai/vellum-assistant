import Foundation
import VellumAssistantShared

/// State management for the command palette (CMD+K).
@MainActor
@Observable
final class CommandPaletteViewModel {
    var query = ""
    var selectedIndex = 0
    var isSearching = false
    var isDeepSearching = false

    /// Static actions (set once at palette creation).
    var actions: [CommandPaletteAction] = []

    /// Recent conversations (set once at palette creation from ConversationManager).
    var recentItems: [CommandPaletteRecentItem] = []

    /// Server search results populated from the global search API.
    var serverResults = GlobalSearchResults.empty

    /// Debounce task for search queries.
    private var searchTask: Task<Void, Never>?

    /// Deep search task that runs after fast results arrive.
    private var deepSearchTask: Task<Void, Never>?

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
        items += serverResults.memories.map { .memory($0) }
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
        !serverResults.memories.isEmpty ||
        !serverResults.schedules.isEmpty ||
        !serverResults.contacts.isEmpty
    }

    /// Resets state for a fresh palette opening.
    func reset() {
        query = ""
        selectedIndex = 0
        isSearching = false
        isDeepSearching = false
        serverResults = .empty
        searchTask?.cancel()
        searchTask = nil
        deepSearchTask?.cancel()
        deepSearchTask = nil
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
        deepSearchTask?.cancel()

        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            serverResults = .empty
            isSearching = false
            isDeepSearching = false
            return
        }

        isSearching = true

        searchTask = Task { [weak self] in
            // 150ms debounce
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }

            guard let self else { return }
            let results = await self.performSearch(query: trimmed, deep: false)

            guard !Task.isCancelled else { return }
            self.serverResults = results
            self.isSearching = false
            self.clampSelection()

            // Auto-fire deep search after fast results arrive
            self.triggerDeepSearch(query: trimmed)
        }
    }

    /// Fires a deep semantic search after the fast phase completes.
    private func triggerDeepSearch(query: String) {
        deepSearchTask?.cancel()
        isDeepSearching = true

        deepSearchTask = Task { [weak self] in
            guard let self else { return }
            let deepResults = await self.performSearch(query: query, deep: true)

            guard !Task.isCancelled else { return }

            // Merge deep memory results with existing, deduplicating by ID
            let existingMemoryIds = Set(self.serverResults.memories.map(\.id))
            let newMemories = deepResults.memories.filter { !existingMemoryIds.contains($0.id) }
            if !newMemories.isEmpty {
                var updated = self.serverResults
                updated = GlobalSearchResults(
                    conversations: updated.conversations,
                    memories: updated.memories + newMemories,
                    schedules: updated.schedules,
                    contacts: updated.contacts
                )
                self.serverResults = updated
                self.clampSelection()
            }
            self.isDeepSearching = false
        }
    }

    private func performSearch(query: String, deep: Bool) async -> GlobalSearchResults {
        var params = ["q": query, "limit": "10"]
        if deep {
            params["deep"] = "true"
            params["categories"] = "memories"
        }

        do {
            let (decoded, response): (GlobalSearchResponse?, _) = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/search/global",
                params: params,
                timeout: deep ? 10 : 5
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
