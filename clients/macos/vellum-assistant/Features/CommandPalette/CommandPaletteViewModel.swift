import Foundation

/// State management for the command palette (CMD+K).
@MainActor
@Observable
final class CommandPaletteViewModel {
    var query = ""
    var selectedIndex = 0

    /// Static actions (set once at palette creation).
    var actions: [CommandPaletteAction] = []

    /// Recent conversations (set once at palette creation from ThreadManager).
    var recentItems: [CommandPaletteRecentItem] = []

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

    /// All visible items in display order (actions first, then recents).
    var allItems: [CommandPaletteItem] {
        filteredActions.map { .action($0) } + filteredRecents.map { .recent($0) }
    }

    /// Total count of visible items.
    var totalItemCount: Int {
        allItems.count
    }

    /// Resets state for a fresh palette opening.
    func reset() {
        query = ""
        selectedIndex = 0
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
}
