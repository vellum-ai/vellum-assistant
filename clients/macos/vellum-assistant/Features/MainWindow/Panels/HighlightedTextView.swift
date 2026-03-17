import SwiftUI
import VellumAssistantShared

/// A code viewer with line numbers, horizontal scrolling, and syntax highlighting.
///
/// Uses pure SwiftUI rendering (TextEditor for editable mode, Text for read-only)
/// to avoid NSTextView compositing issues inside SwiftUI view hierarchies.
struct HighlightedTextView: View {
    @Binding var text: String
    let language: SyntaxLanguage
    let isEditable: Bool
    var onTextChange: ((String) -> Void)?

    @State private var isSearchVisible = false
    @State private var searchQuery = ""
    @State private var currentMatchIndex = 0
    @State private var isActivelyEditing = false

    private static let editorBackground = VColor.surfaceOverlay
    private static let gutterBackground = VColor.surfaceBase
    private static let gutterTextColor = VColor.contentTertiary

    /// Total number of search matches in the text.
    private var searchMatchCount: Int {
        guard !searchQuery.isEmpty else { return 0 }
        return findMatchRanges().count
    }

    var body: some View {
        Group {
            if isEditable {
                if isActivelyEditing {
                    editableView
                } else {
                    readOnlyView
                        .overlay {
                            Color.clear
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    isActivelyEditing = true
                                }
                        }
                }
            } else {
                readOnlyView
            }
        }
        .onChange(of: language) { _, _ in
            isActivelyEditing = false
        }
    }

    // MARK: - Editable Mode

    /// TextEditor-based editable view — no line numbers but text is visible and editable.
    /// Shows search bar with match count but does not highlight matches inline
    /// (TextEditor doesn't support AttributedString).
    private var editableView: some View {
        VStack(spacing: 0) {
            if isSearchVisible {
                SourceSearchBar(
                    searchQuery: $searchQuery,
                    currentMatchIndex: $currentMatchIndex,
                    matchCount: searchMatchCount,
                    onDismiss: dismissSearch
                )
            }

            TextEditor(text: editableBinding)
                .font(VFont.mono)
                .foregroundStyle(VColor.contentDefault)
                .scrollContentBackground(.hidden)
                .background(Self.editorBackground)
                .scrollDisabled(false)
        }
        .onKeyPress("f", phases: .down) { press in
            guard press.modifiers == .command else { return .ignored }
            isSearchVisible = true
            return .handled
        }
        .onKeyPress(.escape) {
            if isSearchVisible {
                dismissSearch()
                return .handled
            }
            if isActivelyEditing {
                isActivelyEditing = false
                return .handled
            }
            return .ignored
        }
        .onChange(of: text) { _, _ in
            let count = searchMatchCount
            if count == 0 {
                currentMatchIndex = 0
            } else if currentMatchIndex >= count {
                currentMatchIndex = max(0, count - 1)
            }
        }
    }

    private var editableBinding: Binding<String> {
        Binding(
            get: { text },
            set: { newValue in
                text = newValue
                onTextChange?(newValue)
            }
        )
    }

    // MARK: - Read-Only Mode

    /// Syntax-highlighted text for the read-only view, with search match highlighting.
    private var highlightedText: AttributedString {
        var result = SyntaxTheme.highlight(text, language: language)

        guard !searchQuery.isEmpty else { return result }

        let matchRanges = findMatchRanges()
        for (index, range) in matchRanges.enumerated() {
            guard let lowerBound = AttributedString.Index(range.lowerBound, within: result),
                  let upperBound = AttributedString.Index(range.upperBound, within: result) else {
                continue
            }

            let attrRange = lowerBound..<upperBound
            if index == currentMatchIndex {
                result[attrRange].backgroundColor = VColor.primaryBase.opacity(0.3)
            } else {
                result[attrRange].backgroundColor = VColor.systemMidWeak
            }
        }

        return result
    }

    /// Read-only view with line numbers and horizontal scrolling.
    private var readOnlyView: some View {
        let lines = text.components(separatedBy: "\n")
        let lineCount = lines.count
        let gutterWidth = gutterWidth(for: lineCount)

        return VStack(spacing: 0) {
            if isSearchVisible {
                SourceSearchBar(
                    searchQuery: $searchQuery,
                    currentMatchIndex: $currentMatchIndex,
                    matchCount: searchMatchCount,
                    onDismiss: dismissSearch
                )
            }

            GeometryReader { geometry in
                ScrollView([.vertical]) {
                    HStack(alignment: .top, spacing: 0) {
                        // Line number gutter — scrolls vertically, pinned horizontally
                        lineNumberGutter(lineCount: lineCount, width: gutterWidth)

                        // Text content — scrolls both directions
                        ScrollView(.horizontal, showsIndicators: true) {
                            Text(highlightedText)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: false)
                                .padding(.vertical, VSpacing.sm)
                                .padding(.horizontal, VSpacing.md)
                        }
                        .frame(minWidth: geometry.size.width - gutterWidth)
                    }
                    .frame(minHeight: geometry.size.height, alignment: .topLeading)
                }
                .background(Self.editorBackground)
            }
        }
        .onKeyPress("f", phases: .down) { press in
            guard press.modifiers == .command else { return .ignored }
            isSearchVisible = true
            return .handled
        }
        .onKeyPress(.escape) {
            guard isSearchVisible else { return .ignored }
            dismissSearch()
            return .handled
        }
        .onChange(of: text) { _, _ in
            let count = searchMatchCount
            if count == 0 {
                currentMatchIndex = 0
            } else if currentMatchIndex >= count {
                currentMatchIndex = max(0, count - 1)
            }
        }
    }

    // MARK: - Search

    /// Finds all case-insensitive occurrences of `searchQuery` in `text`.
    private func findMatchRanges() -> [Range<String.Index>] {
        guard !searchQuery.isEmpty else { return [] }

        var ranges: [Range<String.Index>] = []
        var searchStart = text.startIndex

        while searchStart < text.endIndex,
              let range = text.range(of: searchQuery, options: .caseInsensitive, range: searchStart..<text.endIndex) {
            ranges.append(range)
            searchStart = range.upperBound
        }

        return ranges
    }

    private func dismissSearch() {
        isSearchVisible = false
        searchQuery = ""
    }

    // MARK: - Line Numbers

    private func lineNumberGutter(lineCount: Int, width: CGFloat) -> some View {
        VStack(alignment: .trailing, spacing: 0) {
            ForEach(1...max(1, lineCount), id: \.self) { num in
                Text("\(num)")
                    .font(VFont.monoSmall)
                    .foregroundStyle(Self.gutterTextColor)
                    .frame(height: Self.lineHeight)
            }
        }
        .padding(.top, VSpacing.sm)
        .padding(.trailing, VSpacing.sm)
        .padding(.leading, VSpacing.sm)
        .frame(width: width, alignment: .trailing)
        .background(Self.gutterBackground)
    }

    /// Line height for the text content font, computed from actual NSFont metrics
    /// so the gutter stays aligned even if the font or size changes.
    private static let lineHeight: CGFloat = {
        let nsFont = NSFont(name: "DMMono-Regular", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        return ceil(nsFont.ascender - nsFont.descender + nsFont.leading)
    }()

    private func gutterWidth(for lineCount: Int) -> CGFloat {
        let digitCount = max(3, "\(lineCount)".count)
        return CGFloat(digitCount * 8 + 16)
    }
}

// MARK: - Source Search Bar

/// Search bar for the file viewer source view. Displays match count, prev/next navigation,
/// and a close button.
private struct SourceSearchBar: View {
    @Binding var searchQuery: String
    @Binding var currentMatchIndex: Int
    let matchCount: Int
    let onDismiss: () -> Void

    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.search, size: 12)
                    .foregroundColor(VColor.contentTertiary)

                TextField("Search...", text: $searchQuery)
                    .textFieldStyle(.plain)
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentDefault)
                    .focused($isFocused)
                    .onSubmit { goToNextMatch() }

                if !searchQuery.isEmpty {
                    Text(matchCount > 0 ? "\(currentMatchIndex + 1) of \(matchCount)" : "No results")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .fixedSize()

                    Button(action: goToPreviousMatch) {
                        VIconView(.chevronUp, size: 12)
                            .foregroundColor(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .disabled(matchCount == 0)
                    .accessibilityLabel("Previous match")

                    Button(action: goToNextMatch) {
                        VIconView(.chevronDown, size: 12)
                            .foregroundColor(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .disabled(matchCount == 0)
                    .accessibilityLabel("Next match")
                }

                Button(action: onDismiss) {
                    VIconView(.x, size: 12)
                        .foregroundColor(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close search")
            }
            .padding(VSpacing.sm)
            .background(VColor.surfaceOverlay)

            Divider()
        }
        .onAppear { isFocused = true }
        .onChange(of: searchQuery) { _, _ in
            currentMatchIndex = 0
        }
    }

    private func goToPreviousMatch() {
        guard matchCount > 0 else { return }
        currentMatchIndex = currentMatchIndex > 0 ? currentMatchIndex - 1 : matchCount - 1
    }

    private func goToNextMatch() {
        guard matchCount > 0 else { return }
        currentMatchIndex = currentMatchIndex < matchCount - 1 ? currentMatchIndex + 1 : 0
    }
}
