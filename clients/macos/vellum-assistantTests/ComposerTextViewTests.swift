#if os(macOS)
import AppKit
import XCTest
@testable import VellumAssistantLib

final class ComposerTextViewTests: XCTestCase {

    // MARK: - Helpers

    private func makeTextView() -> ComposerTextView {
        let textView = ComposerTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 100))
        // Ensure the text container and layout manager are wired up for text insertion.
        if textView.textContainer == nil {
            let container = NSTextContainer(containerSize: NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude))
            let layoutManager = NSLayoutManager()
            layoutManager.addTextContainer(container)
            textView.textStorage?.addLayoutManager(layoutManager)
        }
        return textView
    }

    private func makeKeyDown(keyCode: UInt16, modifiers: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "",
            charactersIgnoringModifiers: "",
            isARepeat: false,
            keyCode: keyCode
        )!
    }

    // Key codes
    private let returnKey: UInt16 = 36
    private let numpadEnter: UInt16 = 76
    private let tabKey: UInt16 = 48
    private let upArrow: UInt16 = 126
    private let downArrow: UInt16 = 125
    private let escapeKey: UInt16 = 53

    // MARK: - Return key routing (default mode, cmdEnterToSend = false)

    func testPlainReturnCallsOnSubmit() {
        let textView = makeTextView()
        var didCallOnSubmit = false
        textView.onSubmit = { didCallOnSubmit = true }
        textView.cmdEnterToSend = false

        let event = makeKeyDown(keyCode: returnKey)
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnSubmit, "Plain Return should call onSubmit in default mode")
    }

    func testShiftReturnInsertsNewline() {
        let textView = makeTextView()
        textView.string = "hello"
        textView.setSelectedRange(NSRange(location: 5, length: 0))
        var didCallOnSubmit = false
        textView.onSubmit = { didCallOnSubmit = true }
        textView.cmdEnterToSend = false

        let event = makeKeyDown(keyCode: returnKey, modifiers: [.shift])
        textView.keyDown(with: event)

        XCTAssertFalse(didCallOnSubmit, "Shift+Return should NOT call onSubmit")
        XCTAssertTrue(textView.string.contains("\n"), "Shift+Return should insert a newline character")
    }

    func testOptionReturnCallsOnSubmit() {
        let textView = makeTextView()
        var didCallOnSubmit = false
        textView.onSubmit = { didCallOnSubmit = true }
        textView.cmdEnterToSend = false

        let event = makeKeyDown(keyCode: returnKey, modifiers: [.option])
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnSubmit, "Option+Return should call onSubmit (bridgeSend) in default mode")
    }

    func testCmdReturnDefaultModeDoesNotSend() {
        let textView = makeTextView()
        var didCallOnSubmit = false
        textView.onSubmit = { didCallOnSubmit = true }
        textView.cmdEnterToSend = false

        let event = makeKeyDown(keyCode: returnKey, modifiers: [.command])
        textView.keyDown(with: event)

        XCTAssertFalse(didCallOnSubmit, "Cmd+Return in default mode should NOT call onSubmit (falls through to super)")
    }

    // MARK: - Return key routing (cmdEnterToSend mode)

    func testCmdReturnSendsInCmdEnterMode() {
        let textView = makeTextView()
        var didCallOnSubmit = false
        textView.onSubmit = { didCallOnSubmit = true }
        textView.cmdEnterToSend = true

        let event = makeKeyDown(keyCode: returnKey, modifiers: [.command])
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnSubmit, "Cmd+Return should call onSubmit in cmdEnterToSend mode")
    }

    func testPlainReturnInsertsNewlineInCmdEnterMode() {
        let textView = makeTextView()
        textView.string = "hello"
        textView.setSelectedRange(NSRange(location: 5, length: 0))
        var didCallOnSubmit = false
        textView.onSubmit = { didCallOnSubmit = true }
        textView.cmdEnterToSend = true

        let event = makeKeyDown(keyCode: returnKey)
        textView.keyDown(with: event)

        XCTAssertFalse(didCallOnSubmit, "Plain Return should NOT call onSubmit in cmdEnterToSend mode")
        XCTAssertTrue(textView.string.contains("\n"), "Plain Return should insert a newline in cmdEnterToSend mode")
    }

    // MARK: - Tab routing

    func testTabCallsOnTab() {
        let textView = makeTextView()
        var didCallOnTab = false
        textView.onTab = {
            didCallOnTab = true
            return true
        }

        let event = makeKeyDown(keyCode: tabKey)
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnTab, "Tab should call onTab callback")
    }

    func testTabFallsThroughWhenOnTabReturnsFalse() {
        let textView = makeTextView()
        textView.string = ""
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        var didCallOnTab = false
        textView.onTab = {
            didCallOnTab = true
            return false
        }

        let event = makeKeyDown(keyCode: tabKey)
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnTab, "Tab should call onTab even when it returns false")
        // When onTab returns false, Tab falls through to super which inserts a tab character.
        // The text view should have received the event (we verified onTab was called).
    }

    // MARK: - Arrow key routing

    func testUpArrowCallsOnUpArrow() {
        let textView = makeTextView()
        var didCallOnUpArrow = false
        textView.onUpArrow = {
            didCallOnUpArrow = true
            return true
        }

        let event = makeKeyDown(keyCode: upArrow)
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnUpArrow, "Up arrow should call onUpArrow callback")
    }

    func testDownArrowCallsOnDownArrow() {
        let textView = makeTextView()
        var didCallOnDownArrow = false
        textView.onDownArrow = {
            didCallOnDownArrow = true
            return true
        }

        let event = makeKeyDown(keyCode: downArrow)
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnDownArrow, "Down arrow should call onDownArrow callback")
    }

    // MARK: - Escape routing

    func testEscapeCallsOnEscape() {
        let textView = makeTextView()
        var didCallOnEscape = false
        textView.onEscape = {
            didCallOnEscape = true
            return true
        }

        let event = makeKeyDown(keyCode: escapeKey)
        textView.keyDown(with: event)

        XCTAssertTrue(didCallOnEscape, "Escape should call onEscape callback")
    }

    // MARK: - IME guard

    // Skipped: testMarkedTextSkipsCustomHandling
    // Testing marked text (IME composition) requires an active input context and window
    // to set the marked text state on the NSTextView. Without a real window and input
    // source, hasMarkedText() always returns false, making it impossible to reliably
    // simulate IME composition in a headless test environment.

    // MARK: - Cmd+V paste routing

    func testPerformKeyEquivalentCmdVWithoutImagePassesThrough() {
        let textView = makeTextView()
        var didCallOnPasteImage = false
        textView.onPasteImage = { didCallOnPasteImage = true }

        // Clear the pasteboard to ensure no image content is present
        NSPasteboard.general.clearContents()

        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.command],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "v",
            charactersIgnoringModifiers: "v",
            isARepeat: false,
            keyCode: 9  // 'v' key code
        )!

        let result = textView.performKeyEquivalent(with: event)

        XCTAssertFalse(didCallOnPasteImage, "Cmd+V without image on pasteboard should NOT call onPasteImage")
        XCTAssertFalse(result, "Cmd+V without image on pasteboard should return false (pass through to super)")
    }
}
#endif
