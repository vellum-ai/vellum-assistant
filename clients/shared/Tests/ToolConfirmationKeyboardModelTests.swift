import XCTest
@testable import VellumAssistantShared

final class ToolConfirmationKeyboardModelTests: XCTestCase {

    // MARK: - Default selection

    func testDefaultSelectionIsFirstAction() {
        let model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        XCTAssertEqual(model.selectedAction, .allowOnce)
        XCTAssertEqual(model.selectedIndex, 0)
    }

    func testDefaultSelectionWithTwoActions() {
        let model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .dontAllow])
        XCTAssertEqual(model.selectedAction, .allowOnce)
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Right movement

    func testMoveRightAdvancesSelection() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        model.moveRight()
        XCTAssertEqual(model.selectedAction, .alwaysAllow)
        XCTAssertEqual(model.selectedIndex, 1)
    }

    func testMoveRightTwiceReachesEnd() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        model.moveRight()
        model.moveRight()
        XCTAssertEqual(model.selectedAction, .dontAllow)
        XCTAssertEqual(model.selectedIndex, 2)
    }

    func testMoveRightWrapsToStart() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        model.moveRight() // 1
        model.moveRight() // 2
        model.moveRight() // wraps to 0
        XCTAssertEqual(model.selectedAction, .allowOnce)
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Left movement

    func testMoveLeftWrapsToEnd() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        model.moveLeft() // wraps to 2
        XCTAssertEqual(model.selectedAction, .dontAllow)
        XCTAssertEqual(model.selectedIndex, 2)
    }

    func testMoveLeftFromMiddle() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        model.moveRight() // index 1
        model.moveLeft()  // back to 0
        XCTAssertEqual(model.selectedAction, .allowOnce)
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Two-action row (no Always Allow)

    func testTwoActionRowNavigation() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .dontAllow])
        XCTAssertEqual(model.selectedAction, .allowOnce)

        model.moveRight()
        XCTAssertEqual(model.selectedAction, .dontAllow)

        model.moveRight() // wraps to 0
        XCTAssertEqual(model.selectedAction, .allowOnce)

        model.moveLeft() // wraps to 1
        XCTAssertEqual(model.selectedAction, .dontAllow)
    }

    // MARK: - Round-trip

    func testRoundTripNavigation() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        model.moveRight() // 1
        model.moveRight() // 2
        model.moveLeft()  // 1
        model.moveLeft()  // 0
        XCTAssertEqual(model.selectedAction, .allowOnce)
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Full cycle

    func testFullCycleForward() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        XCTAssertEqual(model.selectedIndex, 0)
        model.moveRight() // 1
        XCTAssertEqual(model.selectedIndex, 1)
        model.moveRight() // 2
        XCTAssertEqual(model.selectedIndex, 2)
        model.moveRight() // wraps to 0
        XCTAssertEqual(model.selectedIndex, 0)
        model.moveRight() // 1
        XCTAssertEqual(model.selectedIndex, 1)
    }

    func testFullCycleBackward() {
        var model = ToolConfirmationKeyboardModel(actions: [.allowOnce, .alwaysAllow, .dontAllow])
        XCTAssertEqual(model.selectedIndex, 0)
        model.moveLeft() // wraps to 2
        XCTAssertEqual(model.selectedIndex, 2)
        model.moveLeft() // 1
        XCTAssertEqual(model.selectedIndex, 1)
        model.moveLeft() // 0
        XCTAssertEqual(model.selectedIndex, 0)
        model.moveLeft() // wraps to 2
        XCTAssertEqual(model.selectedIndex, 2)
    }
}
