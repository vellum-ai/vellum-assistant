import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "NavigationHistory")

/// Manages back/forward navigation stacks for the main window,
/// allowing users to retrace their steps through view selections.
@MainActor
final class NavigationHistory: ObservableObject {

    enum HistoryEntry: Equatable {
        case selection(ViewSelection)
        case chatDefault(threadSnapshot: UUID?)
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
        log.debug("recordTransition called — from: \(String(describing: from)), to: \(String(describing: to)), suppressed: \(self.isSuppressed)")

        guard !isSuppressed else {
            log.debug("recordTransition skipped — suppressed")
            return
        }

        let fromEntry = entry(for: from, persistentThreadId: persistentThreadId)
        let toEntry = entry(for: to, persistentThreadId: persistentThreadId)

        guard fromEntry != toEntry else {
            log.debug("recordTransition skipped — fromEntry == toEntry")
            return
        }

        backStack.append(fromEntry)
        forwardStack.removeAll()

        if backStack.count > maxDepth {
            backStack.removeFirst()
        }

        log.debug("recordTransition recorded — backStack.count: \(self.backStack.count)")
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
