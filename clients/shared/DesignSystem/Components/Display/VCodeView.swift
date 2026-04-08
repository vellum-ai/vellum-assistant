#if os(macOS)
import AppKit
import SwiftUI

/// A read-only code viewer with line numbers, horizontal scrolling, search, and
/// optional syntax highlighting.
///
/// Wraps a non-editable `NSTextView` via `NSViewRepresentable`, giving native
/// macOS text selection (click-drag across lines, Cmd+A, Shift+arrows) and copy
/// (Cmd+C, right-click menu) for free.
///
/// Syntax highlighting is pluggable: pass a `highlighter` closure that receives
/// `(text, paragraphStyle)` and returns an `NSAttributedString`. The closure
/// runs on a background thread; the result is applied on the main thread.
///
/// ```swift
/// VCodeView(
///     text: sourceCode,
///     highlighter: { text, ps in
///         SyntaxTheme.highlightNS(text, language: .swift, paragraphStyle: ps)
///     }
/// )
/// ```
public struct VCodeView: View {
    /// The plain text to display.
    public let text: String

    /// Optional async syntax highlighter. Receives `(text, paragraphStyle)`,
    /// returns an `NSAttributedString` to replace the plain text. Runs on a
    /// background thread via `Task.detached`.
    public var highlighter: ((String, NSParagraphStyle?) -> NSAttributedString)?

    /// Bumped externally to force a re-highlight (e.g. after theme change or
    /// text mutation that doesn't change the string identity).
    public var highlightVersion: UInt64 = 0

    /// Called when the user single-clicks the code content area (not a drag
    /// for text selection). Useful for entering edit mode without an overlay
    /// that would block text selection or steal clicks from child controls.
    public var onContentClick: (() -> Void)?

    /// When false, renders the full code block height and relies on an
    /// ancestor scroll view for vertical scrolling.
    public var allowsVerticalScrolling: Bool = true

    @State private var isSearchVisible = false
    @State private var searchQuery = ""
    @State private var currentMatchIndex = 0
    @State private var cachedLineCount: Int = 1

    public init(
        text: String,
        highlighter: ((String, NSParagraphStyle?) -> NSAttributedString)? = nil,
        highlightVersion: UInt64 = 0,
        onContentClick: (() -> Void)? = nil,
        allowsVerticalScrolling: Bool = true
    ) {
        self.text = text
        self.highlighter = highlighter
        self.highlightVersion = highlightVersion
        self.onContentClick = onContentClick
        self.allowsVerticalScrolling = allowsVerticalScrolling
    }

    public var body: some View {
        VStack(spacing: 0) {
            searchBar
            editorContent
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
            cachedLineCount = Self.countLines(in: text)
            let count = searchMatchCount
            if count == 0 {
                currentMatchIndex = 0
            } else if currentMatchIndex >= count {
                currentMatchIndex = max(0, count - 1)
            }
        }
        .onAppear {
            cachedLineCount = Self.countLines(in: text)
        }
    }

    // MARK: - Sub-views

    /// Search match count for the current query.
    private var searchMatchCount: Int {
        guard !searchQuery.isEmpty else { return 0 }
        return Self.findMatchRanges(in: text, query: searchQuery).count
    }

    @ViewBuilder
    private var searchBar: some View {
        if isSearchVisible {
            VCodeSearchBar(
                searchQuery: $searchQuery,
                currentMatchIndex: $currentMatchIndex,
                matchCount: searchMatchCount,
                onDismiss: dismissSearch
            )
        }
    }

    private var editorContent: some View {
        let lineCount = cachedLineCount
        let gutterWidth = gutterWidth(for: lineCount)
        let content = HStack(alignment: .top, spacing: 0) {
            lineNumberGutter(lineCount: lineCount, width: gutterWidth)

            VCodeTextView(
                text: text,
                highlighter: highlighter,
                highlightVersion: highlightVersion,
                searchQuery: searchQuery,
                currentMatchIndex: currentMatchIndex,
                matchRanges: isSearchVisible
                    ? Self.findMatchRanges(in: text, query: searchQuery) : [],
                onContentClick: onContentClick
            )
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)

        return Group {
            if allowsVerticalScrolling {
                ScrollView([.vertical]) {
                    content
                }
            } else {
                content
            }
        }
        .background(Self.editorBackground)
    }

    // MARK: - Colors

    private static let editorBackground = VColor.surfaceOverlay
    private static let gutterBackground = VColor.surfaceBase
    private static let gutterTextColor = VColor.contentTertiary

    // MARK: - Search

    /// Finds all case-insensitive occurrences of `query` in `text`.
    public static func findMatchRanges(in text: String, query: String) -> [Range<String.Index>] {
        guard !query.isEmpty else { return [] }

        var ranges: [Range<String.Index>] = []
        var searchStart = text.startIndex

        while searchStart < text.endIndex,
              let range = text.range(of: query, options: .caseInsensitive, range: searchStart..<text.endIndex) {
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
                    .font(VFont.bodySmallDefault)
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

    /// Line height derived from NSLayoutManager so the gutter matches the
    /// actual line spacing NSTextView uses.
    public static let lineHeight: CGFloat = {
        let layoutManager = NSLayoutManager()
        return layoutManager.defaultLineHeight(for: VFont.nsMono)
    }()

    /// Approximate width of a single digit in the gutter font.
    private static let gutterDigitWidth: CGFloat = 8
    /// Horizontal padding (leading + trailing) inside the gutter.
    private static let gutterPadding: CGFloat = 16

    private func gutterWidth(for lineCount: Int) -> CGFloat {
        let digitCount = max(3, "\(lineCount)".count)
        return CGFloat(digitCount) * Self.gutterDigitWidth + Self.gutterPadding
    }

    /// Counts newlines without allocating N substrings.
    /// Equivalent to `text.components(separatedBy: "\n").count` but O(1) memory.
    public static func countLines(in text: String) -> Int {
        var count = 1
        for byte in text.utf8 where byte == 0x0A { count += 1 }
        return count
    }
}

// MARK: - VCodeTextView (NSViewRepresentable)

/// Wraps a non-editable `NSTextView` with TextKit 1 for read-only code display.
///
/// Syntax highlighting runs on a background thread via `Task.detached` and the
/// result is applied to the text storage on the main thread. Search highlights
/// are applied as background color attributes and re-applied after async
/// highlighting completes.
struct VCodeTextView: NSViewRepresentable {
    let text: String
    let highlighter: ((String, NSParagraphStyle?) -> NSAttributedString)?
    let highlightVersion: UInt64
    let searchQuery: String
    let currentMatchIndex: Int
    let matchRanges: [Range<String.Index>]
    var onContentClick: (() -> Void)?

    /// The monospaced font used for code display, sourced from the design system.
    private static let codeFont: NSFont = VFont.nsMono

    func makeNSView(context: Context) -> VCodeHorizontalScrollView {
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

        let textView = ClickReportingTextView(frame: .zero, textContainer: textContainer)
        textView.onContentClick = onContentClick
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.usesFontPanel = false
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.autoresizingMask = [.width]

        textView.font = Self.codeFont
        textView.textColor = NSColor(VColor.contentDefault)
        textView.backgroundColor = .clear
        textView.drawsBackground = false

        // Match gutter's .padding(.top, VSpacing.sm)
        textView.textContainerInset = NSSize(width: 0, height: VSpacing.sm)

        // Fixed line height so emoji/tall glyphs don't expand individual lines
        let fixedLineHeight = layoutManager.defaultLineHeight(for: Self.codeFont)
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.minimumLineHeight = fixedLineHeight
        paragraphStyle.maximumLineHeight = fixedLineHeight
        textView.defaultParagraphStyle = paragraphStyle

        context.coordinator.paragraphStyle = paragraphStyle
        context.coordinator.applyText(text, highlighter: highlighter, to: textView)

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
        guard let textView = scrollView.documentView as? ClickReportingTextView else { return }
        textView.onContentClick = onContentClick

        let needsUpdate = context.coordinator.lastText != text
            || context.coordinator.lastVersion != highlightVersion

        if needsUpdate {
            context.coordinator.applyText(text, highlighter: highlighter, to: textView)
            context.coordinator.lastVersion = highlightVersion
        }

        // Apply or clear search match highlighting
        let searchChanged = context.coordinator.lastSearchQuery != searchQuery
            || context.coordinator.lastMatchIndex != currentMatchIndex
            || context.coordinator.lastMatchCount != matchRanges.count

        if needsUpdate || searchChanged {
            context.coordinator.applySearchHighlights(
                matchRanges: matchRanges,
                currentIndex: currentMatchIndex,
                in: textView
            )
            context.coordinator.lastSearchQuery = searchQuery
            context.coordinator.lastMatchIndex = currentMatchIndex
            context.coordinator.lastMatchCount = matchRanges.count
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: VCodeHorizontalScrollView,
        context: Context
    ) -> CGSize? {
        guard let textView = nsView.documentView as? ClickReportingTextView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return nil }
        let height: CGFloat
        if let cached = context.coordinator.cachedHeight {
            height = cached
        } else {
            layoutManager.ensureLayout(for: textContainer)
            let usedRect = layoutManager.usedRect(for: textContainer)
            height = usedRect.height + textView.textContainerInset.height * 2
            context.coordinator.cachedHeight = height
        }
        return CGSize(width: proposal.width ?? 400, height: height)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var lastText: String = ""
        var lastVersion: UInt64 = 0
        var lastSearchQuery: String = ""
        var lastMatchIndex: Int = -1
        var lastMatchCount: Int = 0
        var paragraphStyle: NSParagraphStyle?
        var cachedHeight: CGFloat?
        private var highlightTask: Task<Void, Never>?

        deinit {
            highlightTask?.cancel()
        }

        /// Stored search state so we can re-apply highlights after async
        /// syntax highlighting replaces the attributed string.
        private var currentMatchRanges: [Range<String.Index>] = []
        private var currentMatchIndex: Int = 0
        private weak var currentTextView: NSTextView?

        func applyText(
            _ text: String,
            highlighter: ((String, NSParagraphStyle?) -> NSAttributedString)?,
            to textView: NSTextView
        ) {
            lastText = text
            cachedHeight = nil

            // Apply plain text immediately so the view is never empty
            guard let textStorage = textView.textStorage else { return }
            var baseAttrs: [NSAttributedString.Key: Any] = [
                .font: VCodeTextView.codeFont,
                .foregroundColor: NSColor(VColor.contentDefault),
            ]
            if let ps = paragraphStyle {
                baseAttrs[.paragraphStyle] = ps
            }
            let plain = NSAttributedString(string: text, attributes: baseAttrs)
            textStorage.setAttributedString(plain)

            // Run syntax highlighting on a background thread
            highlightTask?.cancel()
            guard let highlighter else { return }

            let capturedText = text
            let capturedPS = paragraphStyle
            highlightTask = Task.detached(priority: .userInitiated) {
                nonisolated(unsafe) let highlighted = highlighter(capturedText, capturedPS)
                await MainActor.run { [weak self, weak textView] in
                    guard !Task.isCancelled else { return }
                    guard let textView, let storage = textView.textStorage else { return }
                    // Only apply if the text hasn't changed since we started
                    guard (storage.string as String) == capturedText else { return }
                    storage.beginEditing()
                    storage.setAttributedString(highlighted)
                    storage.endEditing()

                    // Invalidate cached height — font variants from highlighting
                    // (bold/italic) may change line heights.
                    self?.cachedHeight = nil

                    // Re-apply search highlights that were wiped by setAttributedString
                    if let self, !self.currentMatchRanges.isEmpty {
                        self.applySearchHighlights(
                            matchRanges: self.currentMatchRanges,
                            currentIndex: self.currentMatchIndex,
                            in: textView
                        )
                    }
                }
            }
        }

        /// Applies background color attributes for search match highlighting.
        func applySearchHighlights(
            matchRanges: [Range<String.Index>],
            currentIndex: Int,
            in textView: NSTextView
        ) {
            // Store for re-application after async highlighting completes
            currentMatchRanges = matchRanges
            currentMatchIndex = currentIndex
            currentTextView = textView

            guard let storage = textView.textStorage else { return }
            let fullRange = NSRange(location: 0, length: storage.length)

            // Clear any existing search highlights
            storage.beginEditing()
            storage.removeAttribute(.backgroundColor, range: fullRange)

            // Apply match highlights
            let matchColor = NSColor(VColor.systemMidWeak)
            let currentMatchColor = NSColor(VColor.primaryBase).withAlphaComponent(0.3)

            for (index, range) in matchRanges.enumerated() {
                let nsRange = NSRange(range, in: storage.string)
                let color = index == currentIndex ? currentMatchColor : matchColor
                storage.addAttribute(.backgroundColor, value: color, range: nsRange)
            }
            storage.endEditing()

            // Scroll the current match into view
            if !matchRanges.isEmpty, currentIndex < matchRanges.count {
                let currentRange = NSRange(matchRanges[currentIndex], in: storage.string)
                textView.scrollRangeToVisible(currentRange)

                // scrollRangeToVisible only scrolls the immediate enclosing
                // NSScrollView (VCodeHorizontalScrollView for horizontal).
                // When vertical scrolling is handled by an ancestor scroll
                // view (allowsVerticalScrolling = false), also scroll that
                // ancestor to make the match visible.
                if let layoutManager = textView.layoutManager,
                   let textContainer = textView.textContainer,
                   let innerScrollView = textView.enclosingScrollView,
                   let outerScrollView = innerScrollView.enclosingScrollView,
                   let outerDocView = outerScrollView.documentView {
                    let glyphRange = layoutManager.glyphRange(
                        forCharacterRange: currentRange,
                        actualCharacterRange: nil
                    )
                    var matchRect = layoutManager.boundingRect(
                        forGlyphRange: glyphRange,
                        in: textContainer
                    )
                    let origin = textView.textContainerOrigin
                    matchRect = matchRect.offsetBy(dx: origin.x, dy: origin.y)
                    let converted = textView.convert(matchRect, to: outerDocView)
                    outerDocView.scrollToVisible(converted)
                }
            }
        }
    }
}

// MARK: - ClickReportingTextView

/// NSTextView subclass that detects single clicks (without drag) on the text
/// content and forwards them via an `onContentClick` closure. This lets
/// callers respond to clicks on the code area specifically, without an
/// overlay that would block text selection or steal events from sibling
/// controls like the search bar.
private class ClickReportingTextView: NSTextView {
    var onContentClick: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        let downLocation = event.locationInWindow
        super.mouseDown(with: event)
        // super.mouseDown blocks until mouse-up (NSTextView runs a tracking
        // loop for text selection). Detect click vs drag here, not in mouseUp
        // which is never called through the normal responder chain.
        guard let currentEvent = window?.currentEvent else { return }
        guard event.clickCount == 1 else { return }
        let upLocation = currentEvent.locationInWindow
        let dx = abs(upLocation.x - downLocation.x)
        let dy = abs(upLocation.y - downLocation.y)
        if dx < 3 && dy < 3 {
            onContentClick?()
        }
    }
}

// MARK: - VCodeSearchBar

/// Search bar for code views. Displays match count, prev/next navigation,
/// and a close button.
public struct VCodeSearchBar: View {
    @Binding public var searchQuery: String
    @Binding public var currentMatchIndex: Int
    public let matchCount: Int
    public let onDismiss: () -> Void

    @FocusState private var isFocused: Bool

    public init(
        searchQuery: Binding<String>,
        currentMatchIndex: Binding<Int>,
        matchCount: Int,
        onDismiss: @escaping () -> Void
    ) {
        self._searchQuery = searchQuery
        self._currentMatchIndex = currentMatchIndex
        self.matchCount = matchCount
        self.onDismiss = onDismiss
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.search, size: 12)
                    .foregroundStyle(VColor.contentTertiary)

                TextField("Search...", text: $searchQuery)
                    .textFieldStyle(.plain)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .focused($isFocused)
                    .onSubmit { goToNextMatch() }

                if !searchQuery.isEmpty {
                    Text(matchCount > 0 ? "\(currentMatchIndex + 1) of \(matchCount)" : "No results")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .fixedSize()

                    Button(action: goToPreviousMatch) {
                        VIconView(.chevronUp, size: 12)
                            .foregroundStyle(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .disabled(matchCount == 0)
                    .accessibilityLabel("Previous match")

                    Button(action: goToNextMatch) {
                        VIconView(.chevronDown, size: 12)
                            .foregroundStyle(matchCount > 0 ? VColor.contentDefault : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .disabled(matchCount == 0)
                    .accessibilityLabel("Next match")
                }

                Button(action: onDismiss) {
                    VIconView(.x, size: 12)
                        .foregroundStyle(VColor.contentTertiary)
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
        .onChange(of: matchCount) { _, newCount in
            // Clamp currentMatchIndex when matches change (e.g. text edits reduce
            // match count) to avoid stale display like "5 of 2".
            if currentMatchIndex >= newCount {
                currentMatchIndex = max(newCount - 1, 0)
            }
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

// MARK: - VCodeHorizontalScrollView

/// NSScrollView that only handles horizontal scrolling, forwarding vertical
/// scroll events to the parent responder chain (SwiftUI's vertical ScrollView).
public class VCodeHorizontalScrollView: NSScrollView {
    override public func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) {
            super.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }
}
#endif
