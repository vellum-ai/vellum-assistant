import SwiftUI
import AppKit
import VellumAssistantShared

// MARK: - Line Number Gutter

/// Renders line numbers in a vertical ruler alongside an `NSTextView`.
private class LineNumberRulerView: NSRulerView {
    private let gutterFont: NSFont
    private let gutterTextColor: NSColor
    private let gutterBgColor: NSColor

    init(scrollView: NSScrollView, textView: NSTextView) {
        self.gutterFont = NSFont(name: "DMMono-Regular", size: 11)
            ?? NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        self.gutterTextColor = NSColor(VColor.contentTertiary)
        self.gutterBgColor = NSColor(VColor.surfaceBase)
        super.init(scrollView: scrollView, orientation: .verticalRuler)
        self.clientView = textView
        self.ruleThickness = 40
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("init(coder:) not supported") }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView = clientView as? NSTextView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return }

        // Fill background
        gutterBgColor.setFill()
        rect.fill()

        let visibleRect = scrollView?.contentView.bounds ?? .zero
        let visibleGlyphRange = layoutManager.glyphRange(forBoundingRect: visibleRect, in: textContainer)
        let visibleCharRange = layoutManager.characterRange(
            forGlyphRange: visibleGlyphRange, actualGlyphRange: nil
        )

        let text = textView.string as NSString
        var lineNumber = 1
        // Count newlines before visible range
        let beforeVisible = text.substring(to: visibleCharRange.location)
        lineNumber += beforeVisible.components(separatedBy: "\n").count - 1

        var glyphIndex = visibleGlyphRange.location
        while glyphIndex < NSMaxRange(visibleGlyphRange) {
            let charRange = layoutManager.characterRange(
                forGlyphRange: NSRange(location: glyphIndex, length: 1), actualGlyphRange: nil
            )
            var lineRect = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: nil)
            lineRect.origin.y -= visibleRect.origin.y

            let attrs: [NSAttributedString.Key: Any] = [
                .font: gutterFont,
                .foregroundColor: gutterTextColor,
            ]
            let lineStr = "\(lineNumber)" as NSString
            let strSize = lineStr.size(withAttributes: attrs)
            let drawPoint = NSPoint(
                x: ruleThickness - strSize.width - 8,
                y: lineRect.origin.y + (lineRect.height - strSize.height) / 2
            )
            lineStr.draw(at: drawPoint, withAttributes: attrs)

            lineNumber += 1
            // Advance to next line
            let lineRange = text.lineRange(for: charRange)
            glyphIndex = NSMaxRange(
                layoutManager.glyphRange(forCharacterRange: lineRange, actualCharacterRange: nil)
            )
        }

        // Update rule thickness based on digit count
        let digitCount = max(3, "\(lineNumber)".count)
        let newThickness = CGFloat(digitCount * 8 + 16)
        if ruleThickness != newThickness {
            ruleThickness = newThickness
        }
    }
}

// MARK: - SyntaxTextView

/// An editable text view with live syntax highlighting, backed by `NSTextView`.
///
/// Wraps `NSScrollView` > `NSTextView` and applies token-based syntax coloring
/// via `SyntaxTheme`. Rehighlighting is debounced at 150ms to avoid per-keystroke
/// lag on large files. Supports horizontal scrolling (no line wrap), native Cmd+F
/// find bar, and bidirectional text binding with SwiftUI.
struct SyntaxTextView: NSViewRepresentable {
    @Binding var text: String
    let language: SyntaxLanguage
    var onTextChange: ((String) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = NSTextView()
        textView.isEditable = true
        textView.isSelectable = true
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.usesFindBar = true
        textView.isIncrementalSearchingEnabled = true
        textView.font = SyntaxTheme.nsMonoFont
        textView.backgroundColor = NSColor(VColor.surfaceOverlay)
        textView.insertionPointColor = NSColor(VColor.contentDefault)
        textView.selectedTextAttributes = [
            .backgroundColor: NSColor(VColor.primaryBase.opacity(0.3))
        ]
        textView.textContainerInset = NSSize(width: VSpacing.md, height: VSpacing.sm)
        textView.delegate = context.coordinator
        textView.string = text

        // Configure text view and container for horizontal scrolling (no line wrap)
        textView.isHorizontallyResizable = true
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        if let textContainer = textView.textContainer {
            textContainer.widthTracksTextView = false
            textContainer.containerSize = NSSize(
                width: CGFloat.greatestFiniteMagnitude,
                height: CGFloat.greatestFiniteMagnitude
            )
        }

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.documentView = textView

        // Set up line number gutter
        scrollView.hasVerticalRuler = true
        scrollView.rulersVisible = true
        let rulerView = LineNumberRulerView(scrollView: scrollView, textView: textView)
        scrollView.verticalRulerView = rulerView

        // Redraw ruler on scroll
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.scrollViewDidScroll(_:)),
            name: NSView.boundsDidChangeNotification,
            object: scrollView.contentView
        )

        // Apply initial highlighting
        SyntaxTheme.applyHighlighting(to: textView.textStorage!, language: language)

        // Store reference in coordinator
        context.coordinator.textView = textView

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        let coordinator = context.coordinator

        // Keep coordinator's parent in sync to avoid stale onTextChange closures
        coordinator.parent = self

        // Sync language change
        if coordinator.language != language {
            coordinator.language = language
            coordinator.rehighlight(textView)
        }

        // Only update text if it changed externally (not from user editing)
        if text != coordinator.lastKnownText {
            coordinator.isUpdatingFromSwiftUI = true
            let selectedRanges = textView.selectedRanges
            textView.string = text
            coordinator.lastKnownText = text
            coordinator.rehighlight(textView)

            // Clamp restored selectedRanges to new text length to avoid
            // NSRangeException when text is externally updated to a shorter value
            let maxLen = (textView.string as NSString).length
            let clampedRanges = selectedRanges.map { rangeValue -> NSValue in
                let range = rangeValue.rangeValue
                let clampedLocation = min(range.location, maxLen)
                let clampedEnd = min(range.location + range.length, maxLen)
                let clampedLength = clampedEnd > clampedLocation ? clampedEnd - clampedLocation : 0
                return NSValue(range: NSRange(location: clampedLocation, length: clampedLength))
            }
            textView.selectedRanges = clampedRanges

            coordinator.isUpdatingFromSwiftUI = false
        }
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: SyntaxTextView
        var lastKnownText: String
        var language: SyntaxLanguage
        var isUpdatingFromSwiftUI = false
        weak var textView: NSTextView?
        private var rehighlightTask: Task<Void, Never>?

        init(_ parent: SyntaxTextView) {
            self.parent = parent
            self.lastKnownText = parent.text
            self.language = parent.language
        }

        func textDidChange(_ notification: Notification) {
            guard !isUpdatingFromSwiftUI,
                  let textView = notification.object as? NSTextView else { return }
            let newText = textView.string
            lastKnownText = newText
            parent.text = newText
            parent.onTextChange?(newText)

            // Redraw line numbers immediately on text change
            if let scrollView = textView.enclosingScrollView {
                scrollView.verticalRulerView?.needsDisplay = true
            }

            // Debounce rehighlighting to avoid per-keystroke lag on large files
            rehighlightTask?.cancel()
            rehighlightTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard !Task.isCancelled else { return }
                self?.rehighlight(textView)
            }
        }

        @objc func scrollViewDidScroll(_ notification: Notification) {
            guard let clipView = notification.object as? NSClipView,
                  let scrollView = clipView.enclosingScrollView else { return }
            scrollView.verticalRulerView?.needsDisplay = true
        }

        func rehighlight(_ textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            storage.beginEditing()
            SyntaxTheme.applyHighlighting(to: storage, language: language)
            storage.endEditing()
        }
    }
}
