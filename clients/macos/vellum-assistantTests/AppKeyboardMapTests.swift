// CGEventPostToPid cannot be unit-tested headlessly; runtime input behavior
// is verified manually. Tests here cover the key-name → key-code map and
// modifier flag composition only.

import Carbon.HIToolbox
import CoreGraphics
import XCTest
@testable import VellumAssistantLib

final class AppKeyboardMapTests: XCTestCase {

    // MARK: - keyMap spot checks

    func testKeyMap_enterMapsToReturn() {
        XCTAssertEqual(AppKeyboard.keyMap["enter"], CGKeyCode(kVK_Return))
    }

    func testKeyMap_returnMapsToReturn() {
        XCTAssertEqual(AppKeyboard.keyMap["return"], CGKeyCode(kVK_Return))
    }

    func testKeyMap_lowercaseA() {
        XCTAssertEqual(AppKeyboard.keyMap["a"], CGKeyCode(kVK_ANSI_A))
    }

    func testKeyMap_lowercaseZ() {
        XCTAssertEqual(AppKeyboard.keyMap["z"], CGKeyCode(kVK_ANSI_Z))
    }

    func testKeyMap_digitZero() {
        XCTAssertEqual(AppKeyboard.keyMap["0"], CGKeyCode(kVK_ANSI_0))
    }

    func testKeyMap_upArrow() {
        XCTAssertEqual(AppKeyboard.keyMap["up"], CGKeyCode(kVK_UpArrow))
    }

    func testKeyMap_space() {
        XCTAssertEqual(AppKeyboard.keyMap["space"], CGKeyCode(kVK_Space))
    }

    func testKeyMap_f1() {
        XCTAssertEqual(AppKeyboard.keyMap["f1"], CGKeyCode(kVK_F1))
    }

    func testKeyMap_f12() {
        XCTAssertEqual(AppKeyboard.keyMap["f12"], CGKeyCode(kVK_F12))
    }

    func testKeyMap_backspaceMapsToDelete() {
        XCTAssertEqual(AppKeyboard.keyMap["backspace"], CGKeyCode(kVK_Delete))
    }

    // MARK: - modifierFlags

    func testModifierFlags_cmdShiftCombines() {
        let flags = AppKeyboard.modifierFlags(["cmd", "shift"])
        XCTAssertEqual(flags, [.maskCommand, .maskShift])
    }

    func testModifierFlags_caseInsensitive() {
        let flags = AppKeyboard.modifierFlags(["CMD"])
        XCTAssertEqual(flags, .maskCommand)
    }
}
