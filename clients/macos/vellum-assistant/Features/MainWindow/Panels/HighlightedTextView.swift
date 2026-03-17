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

    /// Editable view with line number gutter, built on NSTextView + NSRulerView
    /// for proper scroll synchronization between the gutter and text content.
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

            LineNumberTextEditor(text: editableBinding)
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

// MARK: - Line Number Text Editor (NSViewRepresentable)

/// An editable text view with a line number gutter, built on NSTextView + NSRulerView
/// for proper scroll synchronization between the gutter and text content.
private struct LineNumberTextEditor: NSViewRepresentable {
    @Binding var text: String

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        // Use TextKit 1 for reliable line enumeration in the ruler
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)

        let textContainer = NSTextContainer(
            size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        )
        textContainer.widthTracksTextView = false
        layoutManager.addTextContainer(textContainer)

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false

        let contentSize = scrollView.contentSize
        let textView = NSTextView(frame: NSRect(origin: .zero, size: contentSize), textContainer: textContainer)
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isRichText = false
        textView.usesFindBar = false
        textView.font = Self.textFont
        textView.textColor = NSColor(VColor.contentDefault)
        textView.backgroundColor = NSColor(VColor.surfaceOverlay)
        textView.insertionPointColor = NSColor(VColor.contentDefault)
        textView.textContainerInset = NSSize(width: 4, height: 8)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.autoresizingMask = [.width]
        textView.minSize = NSSize(width: contentSize.width, height: 0)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.string = text
        textView.delegate = context.coordinator

        scrollView.documentView = textView

        // Install the line number ruler
        let ruler = LineNumberRulerView(textView: textView)
        scrollView.hasVerticalRuler = true
        scrollView.verticalRulerView = ruler
        scrollView.rulersVisible = true

        context.coordinator.textView = textView

        // Make the text view first responder so the user can immediately type
        DispatchQueue.main.async {
            textView.window?.makeFirstResponder(textView)
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
            (scrollView.verticalRulerView as? LineNumberRulerView)?.invalidateLineNumbers()
        }
    }

    private static let textFont: NSFont = {
        NSFont(name: "DMMono-Regular", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    }()

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: LineNumberTextEditor
        weak var textView: NSTextView?

        init(_ parent: LineNumberTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

// MARK: - Line Number Ruler View

/// Custom ruler view that draws line numbers aligned with NSTextView line fragments.
private final class LineNumberRulerView: NSRulerView {

    private static let gutterFont: NSFont = {
        NSFont(name: "DMMono-Regular", size: 11)
            ?? NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    }()

    private lazy var gutterAttributes: [NSAttributedString.Key: Any] = [
        .font: Self.gutterFont,
        .foregroundColor: NSColor(VColor.contentTertiary)
    ]

    init(textView: NSTextView) {
        super.init(scrollView: textView.enclosingScrollView!, orientation: .verticalRuler)
        self.clientView = textView
        updateThickness()

        NotificationCenter.default.addObserver(
            self, selector: #selector(handleTextChange(_:)),
            name: NSText.didChangeNotification, object: textView
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleScroll(_:)),
            name: NSView.boundsDidChangeNotification, object: scrollView?.contentView
        )
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError()
    }

    func invalidateLineNumbers() {
        updateThickness()
        needsDisplay = true
    }

    @objc private func handleTextChange(_ note: Notification) {
        invalidateLineNumbers()
    }

    @objc private func handleScroll(_ note: Notification) {
        needsDisplay = true
    }

    private func updateThickness() {
        guard let textView = clientView as? NSTextView else { return }
        let lineCount = max(1, textView.string.components(separatedBy: "\n").count)
        let digitCount = max(3, "\(lineCount)".count)
        let newThickness = CGFloat(digitCount * 8 + 16)
        if ruleThickness != newThickness {
            ruleThickness = newThickness
        }
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView = clientView as? NSTextView,
              let layoutManager = textView.layoutManager,
              textView.textContainer != nil else { return }

        NSColor(VColor.surfaceBase).setFill()
        rect.fill()

        let string = textView.string as NSString
        let relativePoint = convert(NSPoint.zero, from: textView)
        let insetY = textView.textContainerInset.height

        guard string.length > 0 else {
            drawLineNumber(1, y: relativePoint.y + insetY, lineHeight: Self.gutterFont.pointSize * 1.4)
            return
        }

        var lineNumber = 1
        var charIndex = 0

        while charIndex < string.length {
            let lineRange = string.lineRange(for: NSRange(location: charIndex, length: 0))
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: lineRange, actualCharacterRange: nil
            )

            if glyphRange.location != NSNotFound && glyphRange.length > 0 {
                let lineRect = layoutManager.lineFragmentRect(
                    forGlyphAt: glyphRange.location, effectiveRange: nil
                )
                let y = relativePoint.y + insetY + lineRect.origin.y

                if y > rect.maxY { break }
                if y + lineRect.height >= rect.minY {
                    drawLineNumber(lineNumber, y: y, lineHeight: lineRect.height)
                }
            }

            lineNumber += 1
            let nextIndex = NSMaxRange(lineRange)
            if nextIndex <= charIndex { break }
            charIndex = nextIndex
        }

        // Handle trailing newline — draw number for the empty last line
        if string.length > 0 && string.character(at: string.length - 1) == 0x0A {
            let glyphCount = layoutManager.numberOfGlyphs
            if glyphCount > 0 {
                let lastRect = layoutManager.lineFragmentRect(
                    forGlyphAt: glyphCount - 1, effectiveRange: nil
                )
                let y = relativePoint.y + insetY + lastRect.maxY
                if y + lastRect.height >= rect.minY && y <= rect.maxY {
                    drawLineNumber(lineNumber, y: y, lineHeight: lastRect.height)
                }
            }
        }
    }

    private func drawLineNumber(_ number: Int, y: CGFloat, lineHeight: CGFloat) {
        let numStr = "\(number)" as NSString
        let size = numStr.size(withAttributes: gutterAttributes)
        numStr.draw(
            at: NSPoint(
                x: ruleThickness - size.width - 8,
                y: y + (lineHeight - size.height) / 2
            ),
            withAttributes: gutterAttributes
        )
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
