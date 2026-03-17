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
                        .onTapGesture {
                            isActivelyEditing = true
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

    /// NSTextView-based editable view with a line number gutter. Uses CodeTextView
    /// (NSViewRepresentable) instead of SwiftUI's TextEditor to control
    /// textContainerInset precisely, ensuring the gutter stays aligned.
    private var editableView: some View {
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
        .onChange(of: text) { _, _ in
            let count = searchMatchCount
            if count == 0 {
                currentMatchIndex = 0
            } else if currentMatchIndex >= count {
                currentMatchIndex = max(0, count - 1)
            }
        }
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
                            Group {
                                if isEditable {
                                    Text(highlightedText)
                                        .textSelection(.disabled)
                                } else {
                                    Text(highlightedText)
                                        .textSelection(.enabled)
                                }
                            }
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
        guard let textView = scrollView.documentView as? CodeNSTextView else { return }
        if textView.string != text {
            let selectedRanges = textView.selectedRanges
            textView.string = text
            textView.selectedRanges = selectedRanges
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
