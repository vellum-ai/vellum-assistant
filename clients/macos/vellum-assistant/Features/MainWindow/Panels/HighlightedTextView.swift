import SwiftUI
import VellumAssistantShared

#if os(macOS)
import AppKit
#endif

/// A code viewer with line numbers, horizontal scrolling, and syntax highlighting.
///
/// Read-only mode delegates to `VCodeView` from the design system, which wraps
/// a non-editable `NSTextView` for native macOS text selection and copy.
/// Editable mode uses `CodeTextView` (also `NSViewRepresentable`) for precise
/// textContainerInset control so the line-number gutter stays aligned.
struct HighlightedTextView: View {
    @Binding var text: String
    let language: SyntaxLanguage
    let isEditable: Bool
    @Binding var isActivelyEditing: Bool
    var onTextChange: ((String) -> Void)?

    @State private var isSearchVisible = false
    @State private var searchQuery = ""
    @State private var currentMatchIndex = 0
    @State private var highlightVersion: UInt64 = 0
    @State private var contentReady = false
    @State private var cachedLineCount: Int = 1

    private static let editorBackground = VColor.surfaceOverlay
    private static let gutterBackground = VColor.surfaceBase
    private static let gutterTextColor = VColor.contentTertiary

    /// Total number of search matches in the text.
    private var searchMatchCount: Int {
        guard !searchQuery.isEmpty else { return 0 }
        return VCodeView.findMatchRanges(in: text, query: searchQuery).count
    }

    /// Approximate width of a single digit in the gutter font.
    private static let gutterDigitWidth: CGFloat = 8
    /// Horizontal padding (leading + trailing) inside the gutter.
    private static let gutterPadding: CGFloat = 16

    var body: some View {
        Group {
            if contentReady {
                if isEditable {
                    if isActivelyEditing {
                        editableView
                    } else {
                        editableReadOnlyView
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
        .task {
            cachedLineCount = VCodeView.countLines(in: text)
            contentReady = true
        }
        .onChange(of: isActivelyEditing) { _, editing in
            if !editing {
                highlightVersion &+= 1
                cachedLineCount = VCodeView.countLines(in: text)
            }
        }
        .onChange(of: language) { _, _ in
            isActivelyEditing = false
            highlightVersion &+= 1
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
                VCodeSearchBar(
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
            cachedLineCount = VCodeView.countLines(in: text)
            let count = searchMatchCount
            if count == 0 {
                currentMatchIndex = 0
            } else if currentMatchIndex >= count {
                currentMatchIndex = max(0, count - 1)
            }
        }
    }

    // MARK: - Read-Only Mode

    /// Read-only view for editable files. Clicking the code content area
    /// (not the search bar or gutter) enters edit mode.
    private var editableReadOnlyView: some View {
        readOnlyCodeView(onContentClick: { isActivelyEditing = true })
    }

    /// Read-only view for non-editable files.
    private var readOnlyView: some View {
        readOnlyCodeView()
    }

    /// Shared read-only `VCodeView` builder. Passes `SyntaxTheme.highlightNS`
    /// as the pluggable syntax highlighter and keeps `highlightVersion` and
    /// `cachedLineCount` in sync when the text changes.
    private func readOnlyCodeView(onContentClick: (() -> Void)? = nil) -> some View {
        VCodeView(
            text: text,
            highlighter: { text, paragraphStyle in
                SyntaxTheme.highlightNS(text, language: language, paragraphStyle: paragraphStyle)
            },
            highlightVersion: highlightVersion,
            onContentClick: onContentClick
        )
        .onChange(of: text) { _, _ in
            highlightVersion &+= 1
            cachedLineCount = VCodeView.countLines(in: text)
        }
    }

    // MARK: - Search

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
                    .frame(height: VCodeView.lineHeight)
            }
        }
        .padding(.top, VSpacing.sm)
        .padding(.trailing, VSpacing.sm)
        .padding(.leading, VSpacing.sm)
        .frame(width: width, alignment: .trailing)
        .background(Self.gutterBackground)
    }


    private func gutterWidth(for lineCount: Int) -> CGFloat {
        let digitCount = max(3, "\(lineCount)".count)
        return CGFloat(digitCount) * Self.gutterDigitWidth + Self.gutterPadding
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

    func makeNSView(context: Context) -> VCodeHorizontalScrollView {
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

        textView.font = VFont.nsMono
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

        let scrollView = VCodeHorizontalScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        return scrollView
    }

    func updateNSView(_ scrollView: VCodeHorizontalScrollView, context: Context) {
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
        nsView: VCodeHorizontalScrollView,
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
