import Foundation
import Observation

/// Manages back/forward navigation stacks for the main window,
/// allowing users to retrace their steps through view selections.
@MainActor
@Observable
final class NavigationHistory {

    enum HistoryEntry: Equatable {
        case selection(ViewSelection)
        case chatDefault(conversationSnapshot: UUID?)

        /// Whether two entries resolve to the same visible state.
        /// `.chatDefault(conversationSnapshot: T)` and `.selection(.conversation(T))` both
        /// display the same conversation, so transitioning between them is a no-op.
        func isEquivalent(to other: HistoryEntry) -> Bool {
            if self == other { return true }
            switch (self.resolvedConversation, other.resolvedConversation) {
            case (.some(let a), .some(let b)): return a == b
            default: return false
            }
        }

        /// The conversation UUID this entry resolves to, if any.
        private var resolvedConversation: UUID? {
            switch self {
            case .selection(.conversation(let id)): return id
            case .chatDefault(let snapshot): return snapshot
            default: return nil
            }
        }
    }

    private(set) var backStack: [HistoryEntry] = []
    private(set) var forwardStack: [HistoryEntry] = []

    let maxDepth: Int = 50

    private var suppressionDepth: Int = 0

    var isSuppressed: Bool { suppressionDepth > 0 }
    var canGoBack: Bool { !backStack.isEmpty }
    var canGoForward: Bool { !forwardStack.isEmpty }

    // MARK: - Entry Conversion

    func entry(for selection: ViewSelection?, persistentConversationId: UUID?) -> HistoryEntry {
        if let selection { return .selection(selection) }
        return .chatDefault(conversationSnapshot: persistentConversationId)
    }

    // MARK: - Recording

    func recordTransition(from: ViewSelection?, to: ViewSelection?, persistentConversationId: UUID?) {
        guard !isSuppressed else { return }

        let fromEntry = entry(for: from, persistentConversationId: persistentConversationId)
        let toEntry = entry(for: to, persistentConversationId: persistentConversationId)

        // Treat chatDefault(conversationSnapshot: T) and .selection(.conversation(T)) as
        // equivalent — they resolve to the same visible state, so recording a
        // transition between them would create a no-op back step.
        guard !fromEntry.isEquivalent(to: toEntry) else { return }

        backStack.append(fromEntry)
        forwardStack.removeAll()

        if backStack.count > maxDepth {
            backStack.removeFirst()
        }
    }

    // MARK: - Navigation

    func popBack(currentSelection: ViewSelection?, persistentConversationId: UUID?) -> HistoryEntry? {
        guard !backStack.isEmpty else { return nil }

        let destination = backStack.removeLast()
        let currentEntry = entry(for: currentSelection, persistentConversationId: persistentConversationId)
        forwardStack.append(currentEntry)

        return destination
    }

    func popForward(currentSelection: ViewSelection?, persistentConversationId: UUID?) -> HistoryEntry? {
        guard !forwardStack.isEmpty else { return nil }

        let destination = forwardStack.removeLast()
        let currentEntry = entry(for: currentSelection, persistentConversationId: persistentConversationId)
        backStack.append(currentEntry)

        return destination
    }

    // MARK: - Suppression

    /// Temporarily suppress recording of transitions within the given closure.
    /// Useful when programmatic navigation (e.g., popBack/popForward) should
    /// not create new history entries.
    func withRecordingSuppressed(_ body: () -> Void) {
        suppressionDepth += 1
        defer { suppressionDepth -= 1 }
        body()
    }
}
