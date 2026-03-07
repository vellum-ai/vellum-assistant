import XCTest
@testable import VellumAssistantLib

@MainActor
final class NavigationHistoryTests: XCTestCase {

    // MARK: - No-op transitions

    func testRecordTransitionSkipsNoOp() {
        let history = NavigationHistory()
        let id = UUID()

        history.recordTransition(from: .thread(id), to: .thread(id), persistentThreadId: nil)

        XCTAssertTrue(history.backStack.isEmpty)
    }

    func testChatDefaultAndThreadWithSameIdAreEquivalent() {
        let history = NavigationHistory()
        let id = UUID()

        // nil selection with persistentThreadId == id → .thread(id) should be no-op
        history.recordTransition(from: nil, to: .thread(id), persistentThreadId: id)

        XCTAssertTrue(history.backStack.isEmpty)
    }

    // MARK: - Chat default snapshot

    func testRecordTransitionCapturesChatDefaultSnapshot() {
        let history = NavigationHistory()
        let someId = UUID()

        // from nil selection (chat default) to settings panel
        history.recordTransition(from: nil, to: .panel(.settings), persistentThreadId: someId)

        XCTAssertEqual(history.backStack, [.chatDefault(threadSnapshot: someId)])
    }

    // MARK: - Round-trip

    func testPopBackAndPopForwardRoundTrip() {
        let history = NavigationHistory()
        let idA = UUID()
        let idB = UUID()
        let idC = UUID()

        // Record A -> B -> C
        history.recordTransition(from: .thread(idA), to: .thread(idB), persistentThreadId: nil)
        history.recordTransition(from: .thread(idB), to: .thread(idC), persistentThreadId: nil)

        // backStack should be [A, B], forwardStack empty
        XCTAssertEqual(history.backStack.count, 2)
        XCTAssertTrue(history.forwardStack.isEmpty)

        // Pop back from C -> should return B
        let first = history.popBack(currentSelection: .thread(idC), persistentThreadId: nil)
        XCTAssertEqual(first, .selection(.thread(idB)))
        XCTAssertEqual(history.forwardStack, [.selection(.thread(idC))])

        // Pop back from B -> should return A
        let second = history.popBack(currentSelection: .thread(idB), persistentThreadId: nil)
        XCTAssertEqual(second, .selection(.thread(idA)))
        XCTAssertEqual(history.forwardStack, [.selection(.thread(idC)), .selection(.thread(idB))])

        // Pop forward from A -> should return B
        let third = history.popForward(currentSelection: .thread(idA), persistentThreadId: nil)
        XCTAssertEqual(third, .selection(.thread(idB)))

        // Pop forward from B -> should return C
        let fourth = history.popForward(currentSelection: .thread(idB), persistentThreadId: nil)
        XCTAssertEqual(fourth, .selection(.thread(idC)))

        // Forward stack should be empty, back stack should have [A, B]
        XCTAssertTrue(history.forwardStack.isEmpty)
        XCTAssertEqual(history.backStack.count, 2)
    }

    // MARK: - Forward cleared on fresh navigation

    func testForwardClearedOnFreshNavigation() {
        let history = NavigationHistory()
        let idA = UUID()
        let idB = UUID()
        let idC = UUID()

        // Record A -> B, then pop back
        history.recordTransition(from: .thread(idA), to: .thread(idB), persistentThreadId: nil)
        _ = history.popBack(currentSelection: .thread(idB), persistentThreadId: nil)

        // Forward stack should have B
        XCTAssertFalse(history.forwardStack.isEmpty)

        // Fresh navigation from A -> C should clear forward stack
        history.recordTransition(from: .thread(idA), to: .thread(idC), persistentThreadId: nil)

        XCTAssertTrue(history.forwardStack.isEmpty)
    }

    // MARK: - Suppression

    func testSuppressionPreventsRecording() {
        let history = NavigationHistory()
        let idA = UUID()
        let idB = UUID()

        history.withRecordingSuppressed {
            history.recordTransition(from: .thread(idA), to: .thread(idB), persistentThreadId: nil)
        }

        XCTAssertTrue(history.backStack.isEmpty)
    }

    // MARK: - Max depth

    func testMaxDepthEnforced() {
        let history = NavigationHistory()

        // Record 55 transitions: each from thread(i) to thread(i+1)
        for _ in 0..<55 {
            let fromId = UUID()
            let toId = UUID()
            // Use unique IDs so no transition is a no-op
            history.recordTransition(
                from: .thread(fromId),
                to: .thread(toId),
                persistentThreadId: nil
            )
        }

        XCTAssertEqual(history.backStack.count, 50)
    }

    // MARK: - Empty stacks

    func testEmptyStacksReturnNil() {
        let history = NavigationHistory()

        XCTAssertNil(history.popBack(currentSelection: nil, persistentThreadId: nil))
        XCTAssertNil(history.popForward(currentSelection: nil, persistentThreadId: nil))
    }

    // MARK: - Computed properties

    func testCanGoBackAndCanGoForwardReflectState() {
        let history = NavigationHistory()

        XCTAssertFalse(history.canGoBack)
        XCTAssertFalse(history.canGoForward)

        let idA = UUID()
        let idB = UUID()
        history.recordTransition(from: .thread(idA), to: .thread(idB), persistentThreadId: nil)

        XCTAssertTrue(history.canGoBack)
        XCTAssertFalse(history.canGoForward)

        _ = history.popBack(currentSelection: .thread(idB), persistentThreadId: nil)

        XCTAssertFalse(history.canGoBack)
        XCTAssertTrue(history.canGoForward)
    }

    // MARK: - Chat default nil snapshot

    func testBackToChatDefaultNilSnapshotResolvesToNil() {
        let history = NavigationHistory()

        // Record from nil selection with nil persistentThreadId to settings
        history.recordTransition(from: nil, to: .panel(.settings), persistentThreadId: nil)

        let destination = history.popBack(currentSelection: .panel(.settings), persistentThreadId: nil)

        XCTAssertEqual(destination, .chatDefault(threadSnapshot: nil))
    }
}
