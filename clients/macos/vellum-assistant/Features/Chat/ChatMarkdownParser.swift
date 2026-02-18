import Foundation
import VellumAssistantShared

// Backward-compatible typealiases — macOS ChatView.swift references these types.
typealias ListItem = MarkdownListItem
typealias MarkdownSegment = MarkdownBlock

/// Delegates to the shared `MarkdownBlockParser`.
func isHeadingLine(_ line: String) -> (level: Int, text: String)? {
    MarkdownBlockParser.parseHeading(line)
}

func isHorizontalRule(_ line: String) -> Bool {
    MarkdownBlockParser.isHorizontalRule(line)
}

func parseListLine(_ line: String) -> ListItem? {
    MarkdownBlockParser.parseListLine(line)
}

func isTableRow(_ line: String) -> Bool {
    MarkdownBlockParser.isTableRow(line)
}

func isTableSeparator(_ line: String) -> Bool {
    MarkdownBlockParser.isTableSeparator(line)
}

func parseTableCells(_ line: String) -> [String] {
    MarkdownBlockParser.parseTableCells(line)
}

func parseMarkdownSegments(_ text: String) -> [MarkdownSegment] {
    MarkdownBlockParser.parse(text)
}

func extractImageSegments(from text: String) -> [MarkdownSegment] {
    MarkdownBlockParser.extractImageBlocks(from: text)
}
