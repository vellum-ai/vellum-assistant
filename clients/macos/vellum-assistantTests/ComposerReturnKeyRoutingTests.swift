#if os(macOS)
import AppKit
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

    func testDefaultMode_optionReturn_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.option])
        XCTAssertEqual(action, .bridgeSend)
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

    // MARK: - Extra modifier flags (capsLock, function, etc.)

    func testDefaultMode_shiftReturnWithCapsLock_insertsNewline() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.shift, .capsLock])
        XCTAssertEqual(action, .bridgeInsertNewline)
    }

    func testDefaultMode_optionReturnWithCapsLock_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: false, modifiers: [.option, .capsLock])
        XCTAssertEqual(action, .bridgeSend)
    }

    func testCmdEnterMode_cmdReturnWithCapsLock_sends() {
        let action = ComposerReturnKeyRouting.resolve(cmdEnterToSend: true, modifiers: [.command, .capsLock])
        XCTAssertEqual(action, .bridgeSend)
    }

    // MARK: - Execution contract

    func testBridgeSendConsumesEventAndCallsOnSend() {
        var sendCount = 0

        let consumed = ComposerReturnKeyRouting.performBridgeAction(.bridgeSend, textView: nil) {
            sendCount += 1
        }

        XCTAssertTrue(consumed)
        XCTAssertEqual(sendCount, 1)
    }

    func testBridgeInsertNewlineConsumesEventWithoutSending() {
        let textView = makeTextView(with: "hello")
        var sendCount = 0

        let consumed = ComposerReturnKeyRouting.performBridgeAction(.bridgeInsertNewline, textView: textView) {
            sendCount += 1
        }

        XCTAssertTrue(consumed)
        XCTAssertEqual(textView.string, "hello\n")
        XCTAssertEqual(sendCount, 0)
    }

    func testCmdEnterModeSubmitInsertsNewlineInsteadOfSending() {
        let textView = makeTextView(with: "hello")
        var sendCount = 0

        ComposerReturnKeyRouting.handleSubmit(
            cmdEnterToSend: true,
            textView: textView
        ) {
            sendCount += 1
        }

        XCTAssertEqual(textView.string, "hello\n")
        XCTAssertEqual(sendCount, 0)
    }

    func testDefaultModeSubmitSendsInsteadOfInsertingNewline() {
        let textView = makeTextView(with: "hello")
        var sendCount = 0

        ComposerReturnKeyRouting.handleSubmit(
            cmdEnterToSend: false,
            textView: textView
        ) {
            sendCount += 1
        }

        XCTAssertEqual(textView.string, "hello")
        XCTAssertEqual(sendCount, 1)
    }

    private func makeTextView(with text: String) -> NSTextView {
        let textView = NSTextView(frame: .zero)
        textView.string = text
        textView.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        return textView
    }
}
#endif
