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

    private static let editorBackground = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.13, green: 0.14, blue: 0.13, alpha: 1.0)
            : NSColor(red: 0.98, green: 0.98, blue: 0.97, alpha: 1.0)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self, language: language, onTextChange: onTextChange)
    }

    func makeNSView(context: Context) -> NSScrollView {
        // Use Apple's factory method — it wires up NSTextStorage, NSLayoutManager,
        // NSTextContainer, NSTextView, NSClipView, and NSScrollView correctly.
        let scrollView = NSTextView.scrollableTextView()
        let textView = scrollView.documentView as! NSTextView

        // Layer-back everything for proper compositing inside SwiftUI
        scrollView.wantsLayer = true
        scrollView.contentView.wantsLayer = true
        textView.wantsLayer = true

        // Enable horizontal scrolling (no word wrap)
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isHorizontallyResizable = true
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )

        textView.isEditable = isEditable
        textView.isSelectable = true
        textView.usesFindPanel = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        // Resolve appearance once — dynamic NSColors may not resolve correctly
        // inside SwiftUI-hosted NSTextViews.
        let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let resolvedTextColor = SyntaxTheme.resolvedBaseTextColor(isDark: isDark)

        textView.font = context.coordinator.baseFont
        textView.textColor = resolvedTextColor
        textView.backgroundColor = Self.editorBackground
        textView.insertionPointColor = resolvedTextColor
        textView.selectedTextAttributes = [
            .backgroundColor: isDark
                ? NSColor(white: 1.0, alpha: 0.15)
                : NSColor(white: 0.0, alpha: 0.12),
        ]

        textView.string = text

        scrollView.hasHorizontalScroller = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = Self.editorBackground
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

        // Defer highlighting to the next run loop iteration so the view is in the
        // window hierarchy and effectiveAppearance resolves correctly.
        DispatchQueue.main.async {
            context.coordinator.applyHighlighting()
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }

        // Refresh coordinator's reference to the current SwiftUI struct
        context.coordinator.parent = self

        // Keep closures and language fresh
        let languageChanged = context.coordinator.language != language
        context.coordinator.language = language
        context.coordinator.onTextChange = onTextChange

        // Sync editability with SwiftUI state
        textView.isEditable = isEditable

        // Re-highlight when language changes even if text hasn't changed
        if languageChanged && text == textView.string {
            context.coordinator.applyHighlighting()
            return
        }

        // Only update text if it differs and the user is not actively editing
        guard text != textView.string else { return }
        guard textView.window?.firstResponder != textView else { return }

        context.coordinator.isUpdatingFromSwiftUI = true
        textView.string = text
        context.coordinator.applyHighlighting()
        context.coordinator.isUpdatingFromSwiftUI = false
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
        coordinator.highlightTask?.cancel()
        coordinator.highlightTask = nil
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
        var highlightTask: Task<Void, Never>?
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
            highlightTask?.cancel()
            highlightTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard !Task.isCancelled else { return }
                self?.applyHighlighting()
            }
        }

        func applyHighlighting() {
            guard let textView = textView, let textStorage = textView.textStorage else { return }

            let fullText = textStorage.string
            if fullText.isEmpty { return }

            let selectedRange = textView.selectedRange()

            // Pre-resolve colors to static sRGB values. Dynamic NSColors
            // (NSColor(name:dynamicProvider:) and NSColor(SwiftUI.Color)) stored
            // in NSAttributedString foreground color attributes may not resolve
            // correctly inside an NSTextView hosted in SwiftUI.
            let isDark = textView.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let resolvedBaseColor = SyntaxTheme.resolvedBaseTextColor(isDark: isDark)

            textStorage.beginEditing()
            textStorage.setAttributes(
                [.font: baseFont, .foregroundColor: resolvedBaseColor],
                range: NSRange(location: 0, length: fullText.utf16.count)
            )

            let tokens = SyntaxTokenizer.tokenize(fullText, language: language)
            for token in tokens {
                textStorage.addAttributes(
                    SyntaxTheme.resolvedAttributes(for: token.type, baseFont: baseFont, isDark: isDark),
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
        // Fill the gutter background with an appearance-aware color
        let gutterColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(white: 0.12, alpha: 1.0)
                : NSColor(white: 0.94, alpha: 1.0)
        }
        gutterColor.setFill()
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
        let lineNumberColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(white: 0.45, alpha: 1.0)
                : NSColor(white: 0.55, alpha: 1.0)
        }
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
