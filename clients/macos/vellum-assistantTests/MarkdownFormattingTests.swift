#if os(macOS)
import AppKit
import XCTest
@testable import VellumAssistantLib

final class MarkdownFormattingTests: XCTestCase {

    // MARK: - apply() — Selection wrapping

    func testApply_wrapsSelectedTextWithBoldMarkers() {
        let result = MarkdownFormatting.apply(
            text: "hello world", selectionStart: 6, selectionEnd: 11, marker: "**"
        )
        XCTAssertEqual(result.text, "hello **world**")
        XCTAssertEqual(result.selectionStart, 8)
        XCTAssertEqual(result.selectionEnd, 13)
    }

    func testApply_wrapsSelectedTextWithItalicMarker() {
        let result = MarkdownFormatting.apply(
            text: "hello world", selectionStart: 6, selectionEnd: 11, marker: "*"
        )
        XCTAssertEqual(result.text, "hello *world*")
        XCTAssertEqual(result.selectionStart, 7)
        XCTAssertEqual(result.selectionEnd, 12)
    }

    func testApply_wrapsSelectedTextWithStrikethroughMarkers() {
        let result = MarkdownFormatting.apply(
            text: "hello world", selectionStart: 6, selectionEnd: 11, marker: "~~"
        )
        XCTAssertEqual(result.text, "hello ~~world~~")
        XCTAssertEqual(result.selectionStart, 8)
        XCTAssertEqual(result.selectionEnd, 13)
    }

    func testApply_wrapsSelectedTextWithInlineCodeMarker() {
        let result = MarkdownFormatting.apply(
            text: "hello world", selectionStart: 6, selectionEnd: 11, marker: "`"
        )
        XCTAssertEqual(result.text, "hello `world`")
        XCTAssertEqual(result.selectionStart, 7)
        XCTAssertEqual(result.selectionEnd, 12)
    }

    // MARK: - apply() — Toggle off

    func testApply_togglesOffBoldWhenAlreadyWrapped() {
        let result = MarkdownFormatting.apply(
            text: "hello **world**", selectionStart: 8, selectionEnd: 13, marker: "**"
        )
        XCTAssertEqual(result.text, "hello world")
        XCTAssertEqual(result.selectionStart, 6)
        XCTAssertEqual(result.selectionEnd, 11)
    }

    func testApply_togglesOffItalicWhenAlreadyWrapped() {
        let result = MarkdownFormatting.apply(
            text: "hello *world*", selectionStart: 7, selectionEnd: 12, marker: "*"
        )
        XCTAssertEqual(result.text, "hello world")
        XCTAssertEqual(result.selectionStart, 6)
        XCTAssertEqual(result.selectionEnd, 11)
    }

    // MARK: - apply() — Empty cursor

    func testApply_insertsPairedMarkersAtCursorWithEmptySelection() {
        let result = MarkdownFormatting.apply(
            text: "hello ", selectionStart: 6, selectionEnd: 6, marker: "**"
        )
        XCTAssertEqual(result.text, "hello ****")
        XCTAssertEqual(result.selectionStart, 8)
        XCTAssertEqual(result.selectionEnd, 8)
    }

    func testApply_insertsPairedBackticksAtCursor() {
        let result = MarkdownFormatting.apply(
            text: "code: ", selectionStart: 6, selectionEnd: 6, marker: "`"
        )
        XCTAssertEqual(result.text, "code: ``")
        XCTAssertEqual(result.selectionStart, 7)
        XCTAssertEqual(result.selectionEnd, 7)
    }

    // MARK: - apply() — Edge cases

    func testApply_wrapsAtStartOfText() {
        let result = MarkdownFormatting.apply(
            text: "hello", selectionStart: 0, selectionEnd: 5, marker: "**"
        )
        XCTAssertEqual(result.text, "**hello**")
        XCTAssertEqual(result.selectionStart, 2)
        XCTAssertEqual(result.selectionEnd, 7)
    }

    func testApply_handlesEmptyText() {
        let result = MarkdownFormatting.apply(
            text: "", selectionStart: 0, selectionEnd: 0, marker: "**"
        )
        XCTAssertEqual(result.text, "****")
        XCTAssertEqual(result.selectionStart, 2)
        XCTAssertEqual(result.selectionEnd, 2)
    }

    // MARK: - matchShortcut()

    func testMatchShortcut_cmdB_returnsBoldMarker() {
        let marker = MarkdownFormatting.matchShortcut(modifiers: [.command], key: "b")
        XCTAssertEqual(marker, "**")
    }

    func testMatchShortcut_cmdI_returnsItalicMarker() {
        let marker = MarkdownFormatting.matchShortcut(modifiers: [.command], key: "i")
        XCTAssertEqual(marker, "*")
    }

    func testMatchShortcut_cmdShiftX_returnsStrikethroughMarker() {
        let marker = MarkdownFormatting.matchShortcut(modifiers: [.command, .shift], key: "x")
        XCTAssertEqual(marker, "~~")
    }

    func testMatchShortcut_cmdShiftC_returnsInlineCodeMarker() {
        let marker = MarkdownFormatting.matchShortcut(modifiers: [.command, .shift], key: "c")
        XCTAssertEqual(marker, "`")
    }

    func testMatchShortcut_returnsNilForUnrecognizedKey() {
        let marker = MarkdownFormatting.matchShortcut(modifiers: [.command], key: "z")
        XCTAssertNil(marker)
    }

    func testMatchShortcut_returnsNilWithoutCommandModifier() {
        let marker = MarkdownFormatting.matchShortcut(modifiers: [], key: "b")
        XCTAssertNil(marker)
    }

    func testMatchShortcut_cmdShiftBReturnsNil() {
        // Cmd+Shift+B is not a formatting shortcut.
        let marker = MarkdownFormatting.matchShortcut(modifiers: [.command, .shift], key: "b")
        XCTAssertNil(marker)
    }

    func testMatchShortcut_ignoresExtraneousModifiers() {
        // capsLock is masked out; only .command remains → matches bold.
        let marker = MarkdownFormatting.matchShortcut(modifiers: [.command, .capsLock], key: "b")
        XCTAssertEqual(marker, "**")
    }
}
#endif
