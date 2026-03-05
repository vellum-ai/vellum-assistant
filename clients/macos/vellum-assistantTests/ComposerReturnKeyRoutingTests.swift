#if os(macOS)
import XCTest
@testable import VellumAssistantLib

final class ComposerReturnKeyRoutingTests: XCTestCase {

    // MARK: - Default mode (cmdEnterToSend: false)

    func testDefaultMode_plainReturn_defersToSubmit() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [])
        XCTAssertEqual(action, .deferToSubmit)
    }

    func testDefaultMode_shiftReturn_insertsNewline() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.shift])
        XCTAssertEqual(action, .bridgeInsertNewline)
    }

    func testDefaultMode_cmdReturn_defersToSubmit() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.command])
        XCTAssertEqual(action, .deferToSubmit)
    }

    func testDefaultMode_cmdShiftReturn_defersToSubmit() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.command, .shift])
        XCTAssertEqual(action, .deferToSubmit)
    }

    // MARK: - Cmd-enter mode (cmdEnterToSend: true)

    func testCmdEnterMode_plainReturn_defersToSubmit() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [])
        XCTAssertEqual(action, .deferToSubmit)
    }

    func testCmdEnterMode_cmdReturn_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.command])
        XCTAssertEqual(action, .bridgeSend)
    }

    func testCmdEnterMode_shiftReturn_defersToSubmit() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.shift])
        XCTAssertEqual(action, .deferToSubmit)
    }

    func testCmdEnterMode_optionReturn_defersToSubmit() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.option])
        XCTAssertEqual(action, .deferToSubmit)
    }
}
#endif
