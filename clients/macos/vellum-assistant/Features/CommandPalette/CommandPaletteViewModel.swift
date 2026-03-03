import Foundation

/// State management for the command palette (CMD+K).
@MainActor
@Observable
final class CommandPaletteViewModel {
    var query = ""
    var selectedIndex = 0

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

    func moveSelectionDown(maxIndex: Int) {
        if selectedIndex < maxIndex {
            selectedIndex += 1
        }
    }
}
