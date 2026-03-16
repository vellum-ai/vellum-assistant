import XCTest
@testable import VellumAssistantLib

@MainActor
final class NavigationHistoryTests: XCTestCase {

    // MARK: - No-op transitions

    func testRecordTransitionSkipsNoOp() {
        let history = NavigationHistory()
        let id = UUID()

        history.recordTransition(from: .conversation(id), to: .conversation(id), persistentConversationId: nil)

        XCTAssertTrue(history.backStack.isEmpty)
    }

    func testChatDefaultAndThreadWithSameIdAreEquivalent() {
        let history = NavigationHistory()
        let id = UUID()

        // nil selection with persistentConversationId == id → .conversation(id) should be no-op
        history.recordTransition(from: nil, to: .conversation(id), persistentConversationId: id)

        XCTAssertTrue(history.backStack.isEmpty)
    }

    // MARK: - Chat default snapshot

    func testRecordTransitionCapturesChatDefaultSnapshot() {
        let history = NavigationHistory()
        let someId = UUID()

        // from nil selection (chat default) to settings panel
        history.recordTransition(from: nil, to: .panel(.settings), persistentConversationId: someId)

        XCTAssertEqual(history.backStack, [.chatDefault(conversationSnapshot: someId)])
    }

    // MARK: - Round-trip

    func testPopBackAndPopForwardRoundTrip() {
        let history = NavigationHistory()
        let idA = UUID()
        let idB = UUID()
        let idC = UUID()

        // Record A -> B -> C
        history.recordTransition(from: .conversation(idA), to: .conversation(idB), persistentConversationId: nil)
        history.recordTransition(from: .conversation(idB), to: .conversation(idC), persistentConversationId: nil)

        // backStack should be [A, B], forwardStack empty
        XCTAssertEqual(history.backStack.count, 2)
        XCTAssertTrue(history.forwardStack.isEmpty)

        // Pop back from C -> should return B
        let first = history.popBack(currentSelection: .conversation(idC), persistentConversationId: nil)
        XCTAssertEqual(first, .selection(.conversation(idB)))
        XCTAssertEqual(history.forwardStack, [.selection(.conversation(idC))])

        // Pop back from B -> should return A
        let second = history.popBack(currentSelection: .conversation(idB), persistentConversationId: nil)
        XCTAssertEqual(second, .selection(.conversation(idA)))
        XCTAssertEqual(history.forwardStack, [.selection(.conversation(idC)), .selection(.conversation(idB))])

        // Pop forward from A -> should return B
        let third = history.popForward(currentSelection: .conversation(idA), persistentConversationId: nil)
        XCTAssertEqual(third, .selection(.conversation(idB)))

        // Pop forward from B -> should return C
        let fourth = history.popForward(currentSelection: .conversation(idB), persistentConversationId: nil)
        XCTAssertEqual(fourth, .selection(.conversation(idC)))

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
        history.recordTransition(from: .conversation(idA), to: .conversation(idB), persistentConversationId: nil)
        _ = history.popBack(currentSelection: .conversation(idB), persistentConversationId: nil)

        // Forward stack should have B
        XCTAssertFalse(history.forwardStack.isEmpty)

        // Fresh navigation from A -> C should clear forward stack
        history.recordTransition(from: .conversation(idA), to: .conversation(idC), persistentConversationId: nil)

        XCTAssertTrue(history.forwardStack.isEmpty)
    }

    // MARK: - Suppression

    func testSuppressionPreventsRecording() {
        let history = NavigationHistory()
        let idA = UUID()
        let idB = UUID()

        history.withRecordingSuppressed {
            history.recordTransition(from: .conversation(idA), to: .conversation(idB), persistentConversationId: nil)
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
                from: .conversation(fromId),
                to: .conversation(toId),
                persistentConversationId: nil
            )
        }

        XCTAssertEqual(history.backStack.count, 50)
    }

    // MARK: - Empty stacks

    func testEmptyStacksReturnNil() {
        let history = NavigationHistory()

        XCTAssertNil(history.popBack(currentSelection: nil, persistentConversationId: nil))
        XCTAssertNil(history.popForward(currentSelection: nil, persistentConversationId: nil))
    }

    // MARK: - Computed properties

    func testCanGoBackAndCanGoForwardReflectState() {
        let history = NavigationHistory()

        XCTAssertFalse(history.canGoBack)
        XCTAssertFalse(history.canGoForward)

        let idA = UUID()
        let idB = UUID()
        history.recordTransition(from: .conversation(idA), to: .conversation(idB), persistentConversationId: nil)

        XCTAssertTrue(history.canGoBack)
        XCTAssertFalse(history.canGoForward)

        _ = history.popBack(currentSelection: .conversation(idB), persistentConversationId: nil)

        XCTAssertFalse(history.canGoBack)
        XCTAssertTrue(history.canGoForward)
    }

    // MARK: - Chat default nil snapshot

    func testBackToChatDefaultNilSnapshotResolvesToNil() {
        let history = NavigationHistory()

        // Record from nil selection with nil persistentConversationId to settings
        history.recordTransition(from: nil, to: .panel(.settings), persistentConversationId: nil)

        let destination = history.popBack(currentSelection: .panel(.settings), persistentConversationId: nil)

        XCTAssertEqual(destination, .chatDefault(conversationSnapshot: nil))
    }
}
