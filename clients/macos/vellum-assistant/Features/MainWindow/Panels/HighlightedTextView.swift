import SwiftUI
import VellumAssistantShared

/// A code viewer with line numbers, horizontal scrolling, and syntax highlighting.
///
/// Read-only mode uses pure SwiftUI (Text with syntax highlighting). Editable mode
/// uses a custom NSTextView wrapper (CodeTextView) for precise textContainerInset
/// control, ensuring line numbers stay aligned with text content.
struct HighlightedTextView: View {
    @Binding var text: String
    let language: SyntaxLanguage
    let isEditable: Bool
    var onTextChange: ((String) -> Void)?

    @State private var isSearchVisible = false
    @State private var searchQuery = ""
    @State private var currentMatchIndex = 0
    @State private var isActivelyEditing = false
    @State private var cachedHighlight: AttributedString?
    @State private var highlightVersion: UInt64 = 0
    @State private var contentReady = false
    @State private var cachedLineCount: Int = 1

    /// Lightweight key for `.task(id:)` so the highlight task re-runs when
    /// either the detected language or the text content changes.
    private struct HighlightKey: Equatable {
        let language: SyntaxLanguage
        let version: UInt64
    }

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
            if contentReady {
                if isEditable {
                    if isActivelyEditing {
                        editableView
                    } else {
                        readOnlyView
                            .onTapGesture {
                                isActivelyEditing = true
                            }
                    }
                } else {
                    readOnlyView
                }
            } else {
                Color.clear
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Self.editorBackground)
            }
        }
        .task { contentReady = true }
        .onChange(of: isActivelyEditing) { _, editing in
            if !editing {
                // readOnlyView's .onChange(of: text) doesn't fire while
                // editableView is shown, so the cache may hold stale content.
                cachedHighlight = nil
                highlightVersion &+= 1
                cachedLineCount = Self.countLines(in: text)
            }
        }
        .onChange(of: language) { _, _ in
            isActivelyEditing = false
        }
    }

    // MARK: - Editable Mode

    /// NSTextView-based editable view with a line number gutter. Uses CodeTextView
    /// (NSViewRepresentable) instead of SwiftUI's TextEditor to control
    /// textContainerInset precisely, ensuring the gutter stays aligned.
    private var editableView: some View {
        let lineCount = cachedLineCount
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
                        lineNumberGutter(lineCount: lineCount, width: gutterWidth)

                        CodeTextView(
                            text: $text,
                            onTextChange: onTextChange,
                            onEscape: {
                                if isSearchVisible {
                                    dismissSearch()
                                } else {
                                    isActivelyEditing = false
                                }
                            },
                            onCommandF: { isSearchVisible = true }
                        )
                        .frame(minWidth: geometry.size.width - gutterWidth)
                    }
                    .frame(minHeight: geometry.size.height, alignment: .topLeading)
                }
                .background(Self.editorBackground)
            }
        }
        .onKeyPress(.escape) {
            if isSearchVisible {
                dismissSearch()
                return .handled
            }
            isActivelyEditing = false
            return .handled
        }
        .onChange(of: text) { _, _ in
            cachedLineCount = Self.countLines(in: text)
            let count = searchMatchCount
            if count == 0 {
                currentMatchIndex = 0
            } else if currentMatchIndex >= count {
                currentMatchIndex = max(0, count - 1)
            }
        }
    }

    // MARK: - Read-Only Mode

    /// Splits an `AttributedString` by newline characters, returning one
    /// sub-string per line. The newline characters themselves are stripped.
    private static func splitLines(_ attrStr: AttributedString) -> [AttributedString] {
        var lines: [AttributedString] = []
        var currentStart = attrStr.startIndex
        let str = String(attrStr.characters)

        for (offset, char) in str.enumerated() where char == "\n" {
            let idx = attrStr.index(attrStr.startIndex, offsetByCharacters: offset)
            lines.append(AttributedString(attrStr[currentStart..<idx]))
            let nextOffset = offset + 1
            if nextOffset < str.count {
                currentStart = attrStr.index(attrStr.startIndex, offsetByCharacters: nextOffset)
            } else {
                currentStart = attrStr.endIndex
            }
        }
        // Last line (or entire string if no newlines)
        if currentStart < attrStr.endIndex {
            lines.append(AttributedString(attrStr[currentStart..<attrStr.endIndex]))
        } else if lines.isEmpty || str.last == "\n" {
            lines.append(AttributedString())
        }
        return lines
    }

    /// Applies search match highlighting to an `AttributedString` representing
    /// a single line. `lineStartOffset` is the character offset of this line
    /// within the full text.
    private func applySearchHighlighting(
        to line: inout AttributedString,
        lineText: Substring,
        matchRanges: [Range<String.Index>]
    ) {
        let lineRange = lineText.startIndex..<lineText.endIndex
        for (index, range) in matchRanges.enumerated() {
            guard range.overlaps(lineRange) else { continue }
            let clampedLower = max(range.lowerBound, lineText.startIndex)
            let clampedUpper = min(range.upperBound, lineText.endIndex)
            let localLower = lineText.distance(from: lineText.startIndex, to: clampedLower)
            let localUpper = lineText.distance(from: lineText.startIndex, to: clampedUpper)
            let charCount = String(line.characters).count
            guard localLower <= charCount, localUpper <= charCount else { continue }
            let attrLower = line.index(line.startIndex, offsetByCharacters: localLower)
            let attrUpper = line.index(line.startIndex, offsetByCharacters: localUpper)
            let attrRange = attrLower..<attrUpper
            if index == currentMatchIndex {
                line[attrRange].backgroundColor = VColor.primaryBase.opacity(0.3)
            } else {
                line[attrRange].backgroundColor = VColor.systemMidWeak
            }
        }
    }

    /// Read-only view with line numbers and horizontal scrolling.
    ///
    /// Uses lazy, per-line rendering: the text is split into individual lines
    /// and each is rendered as a separate `Text` view inside a `LazyVStack`.
    /// Only visible lines are materialised, so scrolling through files with
    /// thousands of lines stays smooth.
    private var readOnlyView: some View {
        let lineCount = cachedLineCount
        let gutterWidth = gutterWidth(for: lineCount)

        // Pre-split highlighted text into per-line attributed strings.
        // When the highlight cache is available we slice the attributed string;
        // otherwise each line is rendered as plain monospaced text (cheap).
        let highlightedLines: [AttributedString]?
        if let cached = cachedHighlight {
            highlightedLines = Self.splitLines(cached)
        } else {
            highlightedLines = nil
        }

        let plainLines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let matchRanges = searchQuery.isEmpty ? [] : findMatchRanges()

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

                        // Text content — lazy per-line rendering with horizontal scroll
                        ScrollView(.horizontal, showsIndicators: true) {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(0..<max(1, plainLines.count), id: \.self) { idx in
                                    lineView(
                                        index: idx,
                                        plainLines: plainLines,
                                        highlightedLines: highlightedLines,
                                        matchRanges: matchRanges
                                    )
                                }
                            }
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
            cachedHighlight = nil
            highlightVersion &+= 1
            cachedLineCount = Self.countLines(in: text)
            let count = searchMatchCount
            if count == 0 {
                currentMatchIndex = 0
            } else if currentMatchIndex >= count {
                currentMatchIndex = max(0, count - 1)
            }
        }
        .task(id: HighlightKey(language: language, version: highlightVersion)) {
            let capturedVersion = highlightVersion
            let t = text
            let l = language
            let result = await Task.detached(priority: .userInitiated) {
                SyntaxTheme.highlight(t, language: l)
            }.value
            if !Task.isCancelled, highlightVersion == capturedVersion {
                cachedHighlight = result
            }
        }
        .onAppear {
            cachedLineCount = Self.countLines(in: text)
        }
    }

    /// Builds the `Text` view for a single line, using the highlighted version
    /// when available and falling back to plain monospaced text.
    private func buildLineText(
        index: Int,
        plainLines: [Substring],
        highlightedLines: [AttributedString]?,
        matchRanges: [Range<String.Index>]
    ) -> Text {
        if let hLines = highlightedLines, index < hLines.count {
            var attrLine = hLines[index]
            if !matchRanges.isEmpty, index < plainLines.count {
                applySearchHighlighting(
                    to: &attrLine,
                    lineText: plainLines[index],
                    matchRanges: matchRanges
                )
            }
            return Text(attrLine)
        } else {
            // Lightweight fallback — no AttributedString creation on the main thread
            let str = index < plainLines.count ? String(plainLines[index]) : ""
            return Text(str)
                .font(VFont.mono)
                .foregroundColor(VColor.contentDefault)
        }
    }

    /// Renders a single line of text with the correct selection and frame.
    @ViewBuilder
    private func lineView(
        index: Int,
        plainLines: [Substring],
        highlightedLines: [AttributedString]?,
        matchRanges: [Range<String.Index>]
    ) -> some View {
        let lineText = buildLineText(
            index: index,
            plainLines: plainLines,
            highlightedLines: highlightedLines,
            matchRanges: matchRanges
        )

        if isEditable {
            lineText
                .textSelection(.disabled)
                .frame(height: Self.lineHeight, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
        } else {
            lineText
                .textSelection(.enabled)
                .frame(height: Self.lineHeight, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
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
        LazyVStack(alignment: .trailing, spacing: 0) {
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

    /// Line height for the text content font, derived from NSLayoutManager so the
    /// gutter matches the actual line spacing NSTextView uses (which rounds each
    /// metric component individually rather than ceiling the sum).
    private static let lineHeight: CGFloat = {
        let nsFont = NSFont(name: "DMMono-Regular", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let layoutManager = NSLayoutManager()
        return layoutManager.defaultLineHeight(for: nsFont)
    }()

    private func gutterWidth(for lineCount: Int) -> CGFloat {
        let digitCount = max(3, "\(lineCount)".count)
        return CGFloat(digitCount * 8 + 16)
    }

    /// Counts newlines in `text` without allocating N substrings.
    /// Equivalent to `text.components(separatedBy: "\n").count` but O(1) memory.
    private static func countLines(in text: String) -> Int {
        var count = 1
        for byte in text.utf8 where byte == 0x0A { count += 1 }
        return count
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

// MARK: - Code Text Editor (NSViewRepresentable)

/// NSTextView wrapper for the editable mode. Using NSTextView directly gives
/// precise control over `textContainerInset`, ensuring line numbers in the
/// adjacent gutter stay perfectly aligned with text content. Uses TextKit 1
/// (NSLayoutManager) so line heights match the gutter's `lineHeight` computation.
private struct CodeTextView: NSViewRepresentable {
    @Binding var text: String
    var onTextChange: ((String) -> Void)?
    var onEscape: (() -> Void)?
    var onCommandF: (() -> Void)?

    func makeNSView(context: Context) -> HorizontalOnlyScrollView {
        // TextKit 1 stack — matches the gutter's NSLayoutManager.defaultLineHeight computation
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)
        let textContainer = NSTextContainer(size: NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        ))
        textContainer.widthTracksTextView = false
        textContainer.heightTracksTextView = false
        textContainer.lineFragmentPadding = VSpacing.md
        layoutManager.addTextContainer(textContainer)

        let textView = CodeNSTextView(frame: .zero, textContainer: textContainer)
        textView.delegate = context.coordinator
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isRichText = false
        textView.usesFontPanel = false
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.autoresizingMask = [.width]

        // Font — DMMono-Regular 13pt with ss05 stylistic set (conventional "f")
        let baseFont = NSFont(name: "DMMono-Regular", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let descriptor = baseFont.fontDescriptor.addingAttributes([
            .featureSettings: [[
                NSFontDescriptor.FeatureKey.typeIdentifier: kStylisticAlternativesType,
                NSFontDescriptor.FeatureKey.selectorIdentifier: kStylisticAltFiveOnSelector,
            ]]
        ])
        textView.font = NSFont(descriptor: descriptor, size: 13) ?? baseFont
        textView.textColor = NSColor(VColor.contentDefault)
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.insertionPointColor = NSColor(VColor.contentDefault)

        // Match gutter's .padding(.top, VSpacing.sm) exactly
        textView.textContainerInset = NSSize(width: 0, height: VSpacing.sm)

        // Fix line height so emoji/tall glyphs don't expand individual lines
        let fixedLineHeight = layoutManager.defaultLineHeight(for: textView.font!)
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.minimumLineHeight = fixedLineHeight
        paragraphStyle.maximumLineHeight = fixedLineHeight
        textView.defaultParagraphStyle = paragraphStyle
        textView.typingAttributes = [
            .font: textView.font!,
            .foregroundColor: textView.textColor!,
            .paragraphStyle: paragraphStyle,
        ]

        textView.onEscape = onEscape
        textView.onCommandF = onCommandF
        textView.string = text

        let scrollView = HorizontalOnlyScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        return scrollView
    }

    func updateNSView(_ scrollView: HorizontalOnlyScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? CodeNSTextView else { return }
        if textView.string != text {
            let selectedRanges = textView.selectedRanges
            textView.string = text
            let length = (text as NSString).length
            let clampedRanges = selectedRanges.compactMap { rangeValue -> NSValue? in
                let range = rangeValue.rangeValue
                let clampedLocation = min(range.location, length)
                let clampedLength = min(range.length, length - clampedLocation)
                return NSValue(range: NSRange(location: clampedLocation, length: clampedLength))
            }
            textView.selectedRanges = clampedRanges.isEmpty
                ? [NSValue(range: NSRange(location: length, length: 0))]
                : clampedRanges
        }
        textView.onEscape = onEscape
        textView.onCommandF = onCommandF
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: HorizontalOnlyScrollView,
        context: Context
    ) -> CGSize? {
        guard let textView = nsView.documentView as? CodeNSTextView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return nil }
        layoutManager.ensureLayout(for: textContainer)
        let usedRect = layoutManager.usedRect(for: textContainer)
        let height = usedRect.height + textView.textContainerInset.height * 2
        return CGSize(width: proposal.width ?? 400, height: height)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    class Coordinator: NSObject, NSTextViewDelegate {
        var parent: CodeTextView

        init(parent: CodeTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            parent.onTextChange?(textView.string)
        }
    }
}

/// NSTextView subclass that forwards Escape and Cmd+F to closures so the
/// SwiftUI layer can handle search toggling and edit mode exit.
private class CodeNSTextView: NSTextView {
    var onEscape: (() -> Void)?
    var onCommandF: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Escape
            onEscape?()
            return
        }
        if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == "f" {
            onCommandF?()
            return
        }
        super.keyDown(with: event)
    }
}

/// NSScrollView that only handles horizontal scrolling, forwarding vertical
/// scroll events to the parent responder chain (SwiftUI's vertical ScrollView).
private class HorizontalOnlyScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) {
            super.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }
}
