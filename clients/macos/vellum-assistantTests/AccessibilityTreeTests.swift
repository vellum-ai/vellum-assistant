import XCTest
@testable import vellum_assistant

final class AccessibilityTreeTests: XCTestCase {

    func testCleanRole() {
        // Test via formatAXTree with a known element
        let element = AXElement(
            id: 1,
            role: "AXButton",
            title: "Submit",
            value: nil,
            frame: CGRect(x: 480, y: 580, width: 40, height: 20),
            isEnabled: true,
            isFocused: false,
            children: [],
            roleDescription: "button",
            identifier: nil,
            url: nil,
            placeholderValue: nil
        )

        let formatted = AccessibilityTreeEnumerator.formatAXTree(
            elements: [element],
            windowTitle: "Test Window",
            appName: "TestApp"
        )

        XCTAssertTrue(formatted.contains("Window: \"Test Window\" (TestApp)"))
        XCTAssertTrue(formatted.contains("[1]"))
        XCTAssertTrue(formatted.contains("Submit"))
        XCTAssertTrue(formatted.contains("(500, 590)")) // midX, midY
    }

    func testShouldFallbackToVision_fewElements() {
        let elements = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 2, role: "AXStaticText", title: "Hello", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]

        XCTAssertTrue(AccessibilityTreeEnumerator.shouldFallbackToVision(elements: elements),
                       "Should fallback when fewer than 3 interactive elements")
    }

    func testShouldNotFallbackToVision_enoughElements() {
        let elements = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 2, role: "AXTextField", title: "Name", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 3, role: "AXButton", title: "Cancel", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]

        XCTAssertFalse(AccessibilityTreeEnumerator.shouldFallbackToVision(elements: elements),
                        "Should not fallback with 3+ interactive elements")
    }

    // MARK: - AX Tree Diff

    func testDiff_identicalTrees_returnsNil() {
        let elements = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        XCTAssertNil(AXTreeDiff.diff(previous: elements, current: elements))
    }

    func testDiff_addedElement() {
        let prev = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let curr = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 2, role: "AXButton", title: "Cancel", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let diff = AXTreeDiff.diff(previous: prev, current: curr)
        XCTAssertNotNil(diff)
        XCTAssertTrue(diff!.contains("Added"))
        XCTAssertTrue(diff!.contains("Cancel"))
    }

    func testDiff_removedElement() {
        let prev = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 2, role: "AXButton", title: "Cancel", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let curr = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let diff = AXTreeDiff.diff(previous: prev, current: curr)
        XCTAssertNotNil(diff)
        XCTAssertTrue(diff!.contains("Removed"))
        XCTAssertTrue(diff!.contains("Cancel"))
    }

    func testDiff_changedValue() {
        let prev = [
            AXElement(id: 1, role: "AXTextField", title: "Name", value: "John", frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let curr = [
            AXElement(id: 1, role: "AXTextField", title: "Name", value: "Jane", frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let diff = AXTreeDiff.diff(previous: prev, current: curr)
        XCTAssertNotNil(diff)
        XCTAssertTrue(diff!.contains("Changed"))
        XCTAssertTrue(diff!.contains("John"))
        XCTAssertTrue(diff!.contains("Jane"))
    }

    func testDiff_focusChange() {
        let prev = [
            AXElement(id: 1, role: "AXTextField", title: "Name", value: nil, frame: .zero,
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let curr = [
            AXElement(id: 1, role: "AXTextField", title: "Name", value: nil, frame: .zero,
                      isEnabled: true, isFocused: true, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let diff = AXTreeDiff.diff(previous: prev, current: curr)
        XCTAssertNotNil(diff)
        XCTAssertTrue(diff!.contains("gained focus"))
    }

    func testDiff_shiftedIds_matchesByStableIdentity() {
        // Simulate ID shift: an element inserted early pushes all subsequent IDs up.
        // The diff should NOT report "OK" or "Submit" as added/removed — only "New Item" is new.
        let prev = [
            AXElement(id: 1, role: "AXButton", title: "OK", value: nil,
                      frame: CGRect(x: 10, y: 10, width: 80, height: 30),
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 2, role: "AXButton", title: "Submit", value: nil,
                      frame: CGRect(x: 100, y: 10, width: 80, height: 30),
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let curr = [
            AXElement(id: 1, role: "AXButton", title: "New Item", value: nil,
                      frame: CGRect(x: 0, y: 10, width: 80, height: 30),
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 2, role: "AXButton", title: "OK", value: nil,
                      frame: CGRect(x: 10, y: 10, width: 80, height: 30),
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil),
            AXElement(id: 3, role: "AXButton", title: "Submit", value: nil,
                      frame: CGRect(x: 100, y: 10, width: 80, height: 30),
                      isEnabled: true, isFocused: false, children: [],
                      roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        ]
        let diff = AXTreeDiff.diff(previous: prev, current: curr)
        XCTAssertNotNil(diff)
        // Only "New Item" should be reported as added
        XCTAssertTrue(diff!.contains("Added"))
        XCTAssertTrue(diff!.contains("New Item"))
        // "OK" and "Submit" should NOT be reported as added or removed
        XCTAssertFalse(diff!.contains("Removed"))
    }

    // MARK: - Flatten

    func testFlattenElements() {
        let child = AXElement(id: 2, role: "AXButton", title: "Child", value: nil, frame: .zero,
                              isEnabled: true, isFocused: false, children: [],
                              roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)
        let parent = AXElement(id: 1, role: "AXGroup", title: "Parent", value: nil, frame: .zero,
                               isEnabled: true, isFocused: false, children: [child],
                               roleDescription: nil, identifier: nil, url: nil, placeholderValue: nil)

        let flat = AccessibilityTreeEnumerator.flattenElements([parent])
        XCTAssertEqual(flat.count, 2)
        XCTAssertEqual(flat[0].id, 1)
        XCTAssertEqual(flat[1].id, 2)
    }
}
