#if os(macOS)
import AppKit
import XCTest
@testable import VellumAssistantLib

final class ComposerReturnKeyRoutingTests: XCTestCase {

    // MARK: - Default mode (cmdEnterToSend: false)

    func testDefaultMode_plainReturn_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [])
        XCTAssertEqual(action, .send)
    }

    func testDefaultMode_shiftReturn_insertsNewline() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.shift])
        XCTAssertEqual(action, .insertNewline)
    }

    func testDefaultMode_optionReturn_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.option])
        XCTAssertEqual(action, .send)
    }

    func testDefaultMode_cmdReturn_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.command])
        XCTAssertEqual(action, .send)
    }

    func testDefaultMode_cmdShiftReturn_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.command, .shift])
        XCTAssertEqual(action, .send)
    }

    // MARK: - Cmd-enter mode (cmdEnterToSend: true)

    func testCmdEnterMode_plainReturn_insertsNewline() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [])
        XCTAssertEqual(action, .insertNewline)
    }

    func testCmdEnterMode_cmdReturn_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.command])
        XCTAssertEqual(action, .send)
    }

    func testCmdEnterMode_shiftReturn_insertsNewline() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.shift])
        XCTAssertEqual(action, .insertNewline)
    }

    func testCmdEnterMode_optionReturn_insertsNewline() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.option])
        XCTAssertEqual(action, .insertNewline)
    }

    // MARK: - Extra modifier flags (capsLock, function, etc.)

    func testDefaultMode_shiftReturnWithCapsLock_insertsNewline() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.shift, .capsLock])
        XCTAssertEqual(action, .insertNewline)
    }

    func testDefaultMode_optionReturnWithCapsLock_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.option, .capsLock])
        XCTAssertEqual(action, .send)
    }

    func testCmdEnterMode_cmdReturnWithCapsLock_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.command, .capsLock])
        XCTAssertEqual(action, .send)
    }

}
#endif
