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

    // MARK: - Bridge contract: event-based communication

    /// Verifies that ComposerBridgeEvents provides the explicit callback
    /// contract that replaced synchronous @Binding writes from AppKit callbacks.
    /// The bridge fires events rather than mutating SwiftUI-owned state directly.
    @MainActor
    func testBridgeEvents_textChangedFiresCallback() {
        var receivedText: String?
        let events = ComposerBridgeEvents(
            textChanged: { receivedText = $0 },
            selectionChanged: nil,
            focusChanged: nil,
            submitRequested: nil
        )

        events.textChanged?("hello")
        XCTAssertEqual(receivedText, "hello")
    }

    @MainActor
    func testBridgeEvents_selectionChangedFiresCallback() {
        var receivedPosition: Int?
        let events = ComposerBridgeEvents(
            textChanged: nil,
            selectionChanged: { receivedPosition = $0 },
            focusChanged: nil,
            submitRequested: nil
        )

        events.selectionChanged?(42)
        XCTAssertEqual(receivedPosition, 42)
    }

    @MainActor
    func testBridgeEvents_focusChangedFiresCallback() {
        var receivedFocus: Bool?
        let events = ComposerBridgeEvents(
            textChanged: nil,
            selectionChanged: nil,
            focusChanged: { receivedFocus = $0 },
            submitRequested: nil
        )

        events.focusChanged?(true)
        XCTAssertEqual(receivedFocus, true)

        events.focusChanged?(false)
        XCTAssertEqual(receivedFocus, false)
    }

    @MainActor
    func testBridgeEvents_submitRequestedFiresCallback() {
        var submitCalled = false
        let events = ComposerBridgeEvents(
            textChanged: nil,
            selectionChanged: nil,
            focusChanged: nil,
            submitRequested: { submitCalled = true }
        )

        events.submitRequested?()
        XCTAssertTrue(submitCalled)
    }

    // MARK: - Bridge commands: one-way commands consumed by coordinator

    @MainActor
    func testBridgeCommands_pendingSetTextIsConsumedOnRead() {
        let commands = ComposerBridgeCommands()
        commands.pendingSetText = "new text"
        XCTAssertEqual(commands.pendingSetText, "new text")

        // Simulate coordinator consuming the command
        let consumed = commands.pendingSetText
        commands.pendingSetText = nil
        XCTAssertEqual(consumed, "new text")
        XCTAssertNil(commands.pendingSetText)
    }

    @MainActor
    func testBridgeCommands_pendingRequestFocusIsConsumedOnRead() {
        let commands = ComposerBridgeCommands()
        commands.pendingRequestFocus = true
        XCTAssertEqual(commands.pendingRequestFocus, true)

        // Simulate coordinator consuming the command
        commands.pendingRequestFocus = nil
        XCTAssertNil(commands.pendingRequestFocus)
    }

    @MainActor
    func testBridgeCommands_pendingReplaceRangeIsConsumedOnRead() {
        let commands = ComposerBridgeCommands()
        commands.pendingReplaceRange = (range: NSRange(location: 5, length: 3), replacement: "emoji")

        XCTAssertNotNil(commands.pendingReplaceRange)
        XCTAssertEqual(commands.pendingReplaceRange?.range, NSRange(location: 5, length: 3))
        XCTAssertEqual(commands.pendingReplaceRange?.replacement, "emoji")

        // Simulate coordinator consuming the command
        commands.pendingReplaceRange = nil
        XCTAssertNil(commands.pendingReplaceRange)
    }

    @MainActor
    func testBridgeCommands_pendingSetEditableIsConsumedOnRead() {
        let commands = ComposerBridgeCommands()
        commands.pendingSetEditable = false
        XCTAssertEqual(commands.pendingSetEditable, false)

        commands.pendingSetEditable = nil
        XCTAssertNil(commands.pendingSetEditable)
    }

}
#endif
