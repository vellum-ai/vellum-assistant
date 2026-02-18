import XCTest
@testable import VellumAssistantShared

final class MarkdownParserTests: XCTestCase {

    // MARK: - Headings

    func testHeading() {
        let blocks = MarkdownBlockParser.parse("# Hello")
        XCTAssertEqual(blocks.count, 1)
        if case .heading(let level, let text) = blocks[0] {
            XCTAssertEqual(level, 1)
            XCTAssertEqual(text, "Hello")
        } else {
            XCTFail("Expected heading block")
        }
    }

    func testHeadingLevels() {
        for level in 1...6 {
            let hashes = String(repeating: "#", count: level)
            let blocks = MarkdownBlockParser.parse("\(hashes) Title")
            XCTAssertEqual(blocks.count, 1)
            if case .heading(let parsedLevel, let text) = blocks[0] {
                XCTAssertEqual(parsedLevel, level)
                XCTAssertEqual(text, "Title")
            } else {
                XCTFail("Expected heading at level \(level)")
            }
        }
    }

    func testHeadingRequiresSpace() {
        let blocks = MarkdownBlockParser.parse("#NoSpace")
        XCTAssertEqual(blocks.count, 1)
        if case .text = blocks[0] {} else {
            XCTFail("Expected text block, not heading")
        }
    }

    // MARK: - Paragraphs

    func testParagraph() {
        let blocks = MarkdownBlockParser.parse("Hello world")
        XCTAssertEqual(blocks.count, 1)
        if case .text(let text) = blocks[0] {
            XCTAssertEqual(text, "Hello world")
        } else {
            XCTFail("Expected text block")
        }
    }

    func testMultipleParagraphs() {
        let blocks = MarkdownBlockParser.parse("First\n\nSecond")
        XCTAssertEqual(blocks.count, 2)
        if case .text(let t1) = blocks[0] { XCTAssertEqual(t1, "First") }
        if case .text(let t2) = blocks[1] { XCTAssertEqual(t2, "Second") }
    }

    // MARK: - Code Blocks

    func testBacktickCodeBlock() {
        let input = "```swift\nlet x = 1\nprint(x)\n```"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .codeBlock(let lang, let code) = blocks[0] {
            XCTAssertEqual(lang, "swift")
            XCTAssertEqual(code, "let x = 1\nprint(x)")
        } else {
            XCTFail("Expected code block")
        }
    }

    func testTildeCodeBlock() {
        let input = "~~~python\nprint('hi')\n~~~"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .codeBlock(let lang, let code) = blocks[0] {
            XCTAssertEqual(lang, "python")
            XCTAssertEqual(code, "print('hi')")
        } else {
            XCTFail("Expected code block")
        }
    }

    func testCodeBlockNoLanguage() {
        let input = "```\nhello\n```"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .codeBlock(let lang, let code) = blocks[0] {
            XCTAssertNil(lang)
            XCTAssertEqual(code, "hello")
        } else {
            XCTFail("Expected code block")
        }
    }

    func testUnclosedCodeBlock() {
        let input = "```swift\nlet x = 1"
        let blocks = MarkdownBlockParser.parse(input)
        // Unclosed fence emits as text
        XCTAssertEqual(blocks.count, 1)
        if case .text = blocks[0] {} else {
            XCTFail("Expected text block for unclosed fence")
        }
    }

    // MARK: - Horizontal Rules

    func testHorizontalRule() {
        for rule in ["---", "***", "___"] {
            let blocks = MarkdownBlockParser.parse(rule)
            XCTAssertEqual(blocks.count, 1)
            if case .horizontalRule = blocks[0] {} else {
                XCTFail("Expected horizontal rule for \(rule)")
            }
        }
    }

    func testHorizontalRuleLong() {
        let blocks = MarkdownBlockParser.parse("------")
        XCTAssertEqual(blocks.count, 1)
        if case .horizontalRule = blocks[0] {} else {
            XCTFail("Expected horizontal rule")
        }
    }

    // MARK: - Unordered Lists

    func testUnorderedList() {
        let input = "- Alpha\n- Beta\n- Gamma"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .list(let items) = blocks[0] {
            XCTAssertEqual(items.count, 3)
            XCTAssertEqual(items[0].text, "Alpha")
            XCTAssertFalse(items[0].ordered)
            XCTAssertEqual(items[1].text, "Beta")
            XCTAssertEqual(items[2].text, "Gamma")
        } else {
            XCTFail("Expected list block")
        }
    }

    func testUnorderedListMarkers() {
        let input = "- Dash\n* Star\n+ Plus"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .list(let items) = blocks[0] {
            XCTAssertEqual(items.count, 3)
        }
    }

    // MARK: - Ordered Lists

    func testOrderedList() {
        let input = "1. First\n2. Second\n3. Third"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .list(let items) = blocks[0] {
            XCTAssertEqual(items.count, 3)
            XCTAssertTrue(items[0].ordered)
            XCTAssertEqual(items[0].number, 1)
            XCTAssertEqual(items[0].text, "First")
            XCTAssertEqual(items[2].number, 3)
        } else {
            XCTFail("Expected list block")
        }
    }

    // MARK: - Indented Lists

    func testIndentedList() {
        let input = "- Parent\n  - Child\n    - Grandchild"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .list(let items) = blocks[0] {
            XCTAssertEqual(items.count, 3)
            XCTAssertEqual(items[0].indent, 0)
            XCTAssertEqual(items[1].indent, 2)
            XCTAssertEqual(items[2].indent, 4)
        } else {
            XCTFail("Expected list block")
        }
    }

    // MARK: - Tables

    func testTable() {
        let input = "| Name | Age |\n| ---- | --- |\n| Alice | 30 |\n| Bob | 25 |"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .table(let headers, let rows) = blocks[0] {
            XCTAssertEqual(headers, ["Name", "Age"])
            XCTAssertEqual(rows.count, 2)
            XCTAssertEqual(rows[0], ["Alice", "30"])
            XCTAssertEqual(rows[1], ["Bob", "25"])
        } else {
            XCTFail("Expected table block")
        }
    }

    func testTableWithAlignment() {
        let input = "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .table(let headers, let rows) = blocks[0] {
            XCTAssertEqual(headers.count, 3)
            XCTAssertEqual(rows.count, 1)
        } else {
            XCTFail("Expected table block")
        }
    }

    // MARK: - Images

    func testImage() {
        let input = "![alt text](https://example.com/img.png)"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 1)
        if case .image(let alt, let url) = blocks[0] {
            XCTAssertEqual(alt, "alt text")
            XCTAssertEqual(url, "https://example.com/img.png")
        } else {
            XCTFail("Expected image block")
        }
    }

    func testImageMixedWithText() {
        let input = "Before ![img](url.png) After"
        let blocks = MarkdownBlockParser.parse(input)
        XCTAssertEqual(blocks.count, 3)
        if case .text(let before) = blocks[0] { XCTAssertEqual(before, "Before") }
        if case .image(let alt, _) = blocks[1] { XCTAssertEqual(alt, "img") }
        if case .text(let after) = blocks[2] { XCTAssertEqual(after, "After") }
    }

    // MARK: - Mixed Content

    func testMixedContent() {
        let input = """
        # Title

        A paragraph.

        - Item 1
        - Item 2

        ```
        code
        ```

        ---
        """
        let blocks = MarkdownBlockParser.parse(input)
        // heading, paragraph, list, codeBlock, horizontalRule
        XCTAssertEqual(blocks.count, 5)
        if case .heading = blocks[0] {} else { XCTFail("Expected heading") }
        if case .text = blocks[1] {} else { XCTFail("Expected text") }
        if case .list = blocks[2] {} else { XCTFail("Expected list") }
        if case .codeBlock = blocks[3] {} else { XCTFail("Expected codeBlock") }
        if case .horizontalRule = blocks[4] {} else { XCTFail("Expected horizontalRule") }
    }

    // MARK: - Helper functions

    func testParseHeading() {
        let result = MarkdownBlockParser.parseHeading("## Hello World")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.level, 2)
        XCTAssertEqual(result?.text, "Hello World")
    }

    func testIsTableRow() {
        XCTAssertTrue(MarkdownBlockParser.isTableRow("| a | b |"))
        XCTAssertFalse(MarkdownBlockParser.isTableRow("not a table"))
        XCTAssertFalse(MarkdownBlockParser.isTableRow("| only one pipe"))
    }

    func testParseTableCells() {
        let cells = MarkdownBlockParser.parseTableCells("| foo | bar | baz |")
        XCTAssertEqual(cells, ["foo", "bar", "baz"])
    }

    func testParseListLine() {
        let item = MarkdownBlockParser.parseListLine("  - Hello")
        XCTAssertNotNil(item)
        XCTAssertEqual(item?.indent, 2)
        XCTAssertEqual(item?.text, "Hello")
        XCTAssertFalse(item?.ordered ?? true)
    }
}
