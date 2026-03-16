import AppKit
import SwiftUI

/// A syntax-highlighted text view backed by NSTextView with line numbers and scrolling.
///
/// Wraps an NSTextView inside an NSScrollView with a line-number gutter.
/// Supports both editable and read-only modes, Cmd+F find panel, and
/// debounced re-highlighting on text changes.
struct HighlightedTextView: NSViewRepresentable {
    @Binding var text: String
    let language: SyntaxLanguage
    let isEditable: Bool
    var onTextChange: ((String) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self, language: language, onTextChange: onTextChange)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textContainer = NSTextContainer()
        textContainer.widthTracksTextView = false
        textContainer.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )

        let textView = NSTextView(frame: .zero, textContainer: textContainer)
        textView.isEditable = isEditable
        textView.isSelectable = true
        textView.isRichText = false
        textView.usesFindPanel = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.font = context.coordinator.baseFont
        textView.textColor = SyntaxTheme.baseTextColor
        textView.backgroundColor = .clear
        textView.insertionPointColor = SyntaxTheme.baseTextColor
        textView.selectedTextAttributes = [.backgroundColor: NSColor(white: 1.0, alpha: 0.15)]
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )

        textView.string = text

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true
        scrollView.contentInsets = NSEdgeInsets(top: 8, left: 0, bottom: 8, right: 8)

        let rulerView = LineNumberRulerView()
        rulerView.textView = textView
        rulerView.configure(textView: textView, scrollView: scrollView)
        scrollView.verticalRulerView = rulerView
        scrollView.hasVerticalRuler = true
        scrollView.rulersVisible = true

        textView.delegate = context.coordinator
        context.coordinator.textView = textView
        context.coordinator.rulerView = rulerView
        context.coordinator.applyHighlighting()

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }

        // Keep closures and language fresh
        context.coordinator.language = language
        context.coordinator.onTextChange = onTextChange

        // Only update text if it differs and the user is not actively editing
        guard text != textView.string else { return }
        guard textView.window?.firstResponder != textView else { return }

        context.coordinator.isUpdatingFromSwiftUI = true
        textView.string = text
        context.coordinator.applyHighlighting()
        context.coordinator.isUpdatingFromSwiftUI = false
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
        coordinator.highlightWorkItem?.cancel()
        coordinator.highlightWorkItem = nil
        coordinator.rulerView?.removeAllObservers()
        coordinator.textView = nil
        coordinator.rulerView = nil
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, NSTextViewDelegate {
        var textView: NSTextView?
        fileprivate var rulerView: LineNumberRulerView?
        var language: SyntaxLanguage
        var onTextChange: ((String) -> Void)?
        var isUpdatingFromSwiftUI = false
        var highlightWorkItem: DispatchWorkItem?
        var parent: HighlightedTextView

        lazy var baseFont: NSFont = {
            NSFont(name: "DMMono-Regular", size: 13)
                ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        }()

        init(parent: HighlightedTextView, language: SyntaxLanguage, onTextChange: ((String) -> Void)?) {
            self.parent = parent
            self.language = language
            self.onTextChange = onTextChange
        }

        func textDidChange(_ notification: Notification) {
            guard !isUpdatingFromSwiftUI else { return }
            guard let textView = notification.object as? NSTextView else { return }

            let newString = textView.string
            parent.text = newString
            onTextChange?(newString)

            // Debounce re-highlighting at 50ms
            highlightWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.applyHighlighting()
            }
            highlightWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: workItem)
        }

        func applyHighlighting() {
            guard let textView = textView, let textStorage = textView.textStorage else { return }

            let fullText = textStorage.string
            if fullText.isEmpty { return }

            let selectedRange = textView.selectedRange()

            textStorage.beginEditing()
            textStorage.setAttributes(
                [.font: baseFont, .foregroundColor: SyntaxTheme.baseTextColor],
                range: NSRange(location: 0, length: fullText.utf16.count)
            )

            let tokens = SyntaxTokenizer.tokenize(fullText, language: language)
            for token in tokens {
                textStorage.addAttributes(
                    SyntaxTheme.attributes(for: token.type, baseFont: baseFont),
                    range: token.range
                )
            }

            textStorage.endEditing()
            textView.setSelectedRange(selectedRange)
            rulerView?.needsDisplay = true
        }
    }
}

// MARK: - LineNumberRulerView

private final class LineNumberRulerView: NSRulerView {
    var textView: NSTextView?
    private var notificationObservers: [NSObjectProtocol] = []

    override var requiredThickness: CGFloat {
        guard let textView = textView else { return 32 }
        let lineCount = textView.string.components(separatedBy: "\n").count
        let digitCount = max(3, "\(lineCount)".count)
        return CGFloat(digitCount * 8 + 16)
    }

    func configure(textView: NSTextView, scrollView: NSScrollView) {
        self.textView = textView

        let textObserver = NotificationCenter.default.addObserver(
            forName: NSText.didChangeNotification,
            object: textView,
            queue: .main
        ) { [weak self] _ in
            self?.needsDisplay = true
        }

        scrollView.contentView.postsBoundsChangedNotifications = true
        let boundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: scrollView.contentView,
            queue: .main
        ) { [weak self] _ in
            self?.needsDisplay = true
        }

        notificationObservers = [textObserver, boundsObserver]
    }

    func removeAllObservers() {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        notificationObservers.removeAll()
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        // Fill the gutter background
        NSColor(white: 0.12, alpha: 1.0).setFill()
        rect.fill()

        guard let textView = textView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer
        else { return }

        let visibleRect = scrollView?.contentView.bounds ?? .zero
        let visibleGlyphRange = layoutManager.glyphRange(
            forBoundingRect: visibleRect,
            in: textContainer
        )
        let visibleCharRange = layoutManager.characterRange(
            forGlyphRange: visibleGlyphRange,
            actualGlyphRange: nil
        )

        let text = textView.string as NSString
        let lineNumberFont = NSFont(name: "DMMono-Regular", size: 11)
            ?? NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        let lineNumberColor = NSColor(white: 0.45, alpha: 1.0)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: lineNumberFont,
            .foregroundColor: lineNumberColor,
        ]

        // Count lines before the visible range to determine starting line number
        var lineNumber = 1
        let textBeforeVisible = text.substring(to: visibleCharRange.location)
        for char in textBeforeVisible {
            if char == "\n" {
                lineNumber += 1
            }
        }

        let textContainerInset = textView.textContainerInset
        let rightMargin: CGFloat = 8

        layoutManager.enumerateLineFragments(
            forGlyphRange: visibleGlyphRange
        ) { [weak self] lineRect, _, _, glyphRange, _ in
            guard let self = self else { return }

            // Calculate y position relative to the ruler's coordinate system
            let yPosition = lineRect.origin.y + textContainerInset.height - visibleRect.origin.y

            let lineString = NSAttributedString(string: "\(lineNumber)", attributes: attrs)
            let stringSize = lineString.size()

            let drawX = self.requiredThickness - stringSize.width - rightMargin
            let drawY = yPosition + (lineRect.height - stringSize.height) / 2.0

            lineString.draw(at: NSPoint(x: drawX, y: drawY))

            // Advance line number: with horizontal scrolling enabled
            // (widthTracksTextView = false), each line fragment corresponds
            // to exactly one logical text line, so increment by one.
            lineNumber += 1
        }
    }
}
