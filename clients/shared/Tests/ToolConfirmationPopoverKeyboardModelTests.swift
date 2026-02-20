import XCTest
@testable import VellumAssistantShared

final class ToolConfirmationPopoverKeyboardModelTests: XCTestCase {

    // MARK: - Default selection

    func testDefaultSelectionIsFirstItem() {
        let model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 3)
        XCTAssertEqual(model.selectedIndex, 0)
        XCTAssertEqual(model.mode, .patterns)
    }

    func testDefaultSelectionInScopesMode() {
        let model = ToolConfirmationPopoverKeyboardModel(mode: .scopes, itemCount: 2)
        XCTAssertEqual(model.selectedIndex, 0)
        XCTAssertEqual(model.mode, .scopes)
    }

    // MARK: - Down movement

    func testMoveDownAdvancesSelection() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 3)
        model.moveDown()
        XCTAssertEqual(model.selectedIndex, 1)
    }

    func testMoveDownWrapsToStart() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 3)
        model.moveDown() // 1
        model.moveDown() // 2
        model.moveDown() // wraps to 0
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Up movement

    func testMoveUpWrapsToEnd() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 3)
        model.moveUp() // wraps to 2
        XCTAssertEqual(model.selectedIndex, 2)
    }

    func testMoveUpFromMiddle() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 3)
        model.moveDown() // 1
        model.moveUp()   // 0
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Full cycle

    func testFullCycleDown() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 3)
        XCTAssertEqual(model.selectedIndex, 0)
        model.moveDown()
        XCTAssertEqual(model.selectedIndex, 1)
        model.moveDown()
        XCTAssertEqual(model.selectedIndex, 2)
        model.moveDown()
        XCTAssertEqual(model.selectedIndex, 0)
    }

    func testFullCycleUp() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .scopes, itemCount: 2)
        XCTAssertEqual(model.selectedIndex, 0)
        model.moveUp()
        XCTAssertEqual(model.selectedIndex, 1)
        model.moveUp()
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Single item

    func testSingleItemMoveDownStaysAtZero() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 1)
        model.moveDown()
        XCTAssertEqual(model.selectedIndex, 0)
    }

    func testSingleItemMoveUpStaysAtZero() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 1)
        model.moveUp()
        XCTAssertEqual(model.selectedIndex, 0)
    }

    // MARK: - Escape handling

    func testEscapeFromPatternsClosesPopover() {
        let model = ToolConfirmationPopoverKeyboardModel(mode: .patterns, itemCount: 3)
        XCTAssertEqual(model.handleEscape(), .closePopover)
    }

    func testEscapeFromScopesGoesBackToPatterns() {
        let model = ToolConfirmationPopoverKeyboardModel(mode: .scopes, itemCount: 2)
        XCTAssertEqual(model.handleEscape(), .backToPatterns)
    }

    // MARK: - Mode preservation

    func testMovementPreservesMode() {
        var model = ToolConfirmationPopoverKeyboardModel(mode: .scopes, itemCount: 3)
        model.moveDown()
        XCTAssertEqual(model.mode, .scopes)
        model.moveUp()
        XCTAssertEqual(model.mode, .scopes)
    }
}
