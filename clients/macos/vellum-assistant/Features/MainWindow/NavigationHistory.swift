import Foundation

/// Manages back/forward navigation stacks for the main window,
/// allowing users to retrace their steps through view selections.
@MainActor
final class NavigationHistory: ObservableObject {

    enum HistoryEntry: Equatable {
        case selection(ViewSelection)
        case chatDefault(threadSnapshot: UUID?)

        /// Whether two entries resolve to the same visible state.
        /// `.chatDefault(threadSnapshot: T)` and `.selection(.thread(T))` both
        /// display the same thread, so transitioning between them is a no-op.
        func isEquivalent(to other: HistoryEntry) -> Bool {
            if self == other { return true }
            switch (self.resolvedThread, other.resolvedThread) {
            case (.some(let a), .some(let b)): return a == b
            default: return false
            }
        }

        /// The thread UUID this entry resolves to, if any.
        private var resolvedThread: UUID? {
            switch self {
            case .selection(.thread(let id)): return id
            case .chatDefault(let snapshot): return snapshot
            default: return nil
            }
        }
    }

    @Published private(set) var backStack: [HistoryEntry] = []
    @Published private(set) var forwardStack: [HistoryEntry] = []

    let maxDepth: Int = 50

    private var suppressionDepth: Int = 0

    var isSuppressed: Bool { suppressionDepth > 0 }
    var canGoBack: Bool { !backStack.isEmpty }
    var canGoForward: Bool { !forwardStack.isEmpty }

    // MARK: - Entry Conversion

    func entry(for selection: ViewSelection?, persistentThreadId: UUID?) -> HistoryEntry {
        if let selection { return .selection(selection) }
        return .chatDefault(threadSnapshot: persistentThreadId)
    }

    // MARK: - Recording

    func recordTransition(from: ViewSelection?, to: ViewSelection?, persistentThreadId: UUID?) {
        guard !isSuppressed else { return }

        let fromEntry = entry(for: from, persistentThreadId: persistentThreadId)
        let toEntry = entry(for: to, persistentThreadId: persistentThreadId)

        // Treat chatDefault(threadSnapshot: T) and .selection(.thread(T)) as
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

    func popBack(currentSelection: ViewSelection?, persistentThreadId: UUID?) -> HistoryEntry? {
        guard !backStack.isEmpty else { return nil }

        let destination = backStack.removeLast()
        let currentEntry = entry(for: currentSelection, persistentThreadId: persistentThreadId)
        forwardStack.append(currentEntry)

        return destination
    }

    func popForward(currentSelection: ViewSelection?, persistentThreadId: UUID?) -> HistoryEntry? {
        guard !forwardStack.isEmpty else { return nil }

        let destination = forwardStack.removeLast()
        let currentEntry = entry(for: currentSelection, persistentThreadId: persistentThreadId)
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
