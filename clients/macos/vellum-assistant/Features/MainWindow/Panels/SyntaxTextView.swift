import SwiftUI
import AppKit
import VellumAssistantShared

// MARK: - SyntaxTextView

/// An editable text view with live syntax highlighting, backed by `NSTextView`.
///
/// Wraps `HorizontalOnlyScrollView` > `NSTextView` and applies token-based syntax
/// coloring via `SyntaxTheme`. Rehighlighting is debounced at 150ms to avoid
/// per-keystroke lag on large files. Only handles horizontal scrolling — the parent
/// SwiftUI `ScrollView([.vertical])` handles vertical scrolling, matching the
/// proven architecture from `CodeTextView`.
struct SyntaxTextView: NSViewRepresentable {
    @Binding var text: String
    let language: SyntaxLanguage
    var onTextChange: ((String) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> HorizontalOnlyScrollView {
        // Explicit TextKit 1 stack — gives full control over text container sizing
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

        let textView = NSTextView(frame: .zero, textContainer: textContainer)

        // Appearance — transparent so SwiftUI background shows through
        textView.font = SyntaxTheme.nsMonoFont
        textView.textColor = SyntaxTheme.nsContentDefault
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.insertionPointColor = SyntaxTheme.nsContentDefault
        textView.selectedTextAttributes = [
            .backgroundColor: NSColor(VColor.primaryBase.opacity(0.3))
        ]

        // Match gutter's .padding(.top, VSpacing.sm) exactly
        textView.textContainerInset = NSSize(width: 0, height: VSpacing.sm)

        // Fix line height so emoji/tall glyphs don't expand individual lines
        // and lines stay aligned with the SwiftUI gutter
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

        // Behavior
        textView.delegate = context.coordinator
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isRichText = true
        textView.usesFontPanel = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.usesFindBar = true
        textView.isIncrementalSearchingEnabled = true

        // Sizing — autoresizingMask is critical for the text view to fill the
        // scroll view's width. Without it, the text view stays at zero width.
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )

        // Content
        textView.string = text

        // Horizontal-only scroll view — vertical scrolling handled by SwiftUI
        let scrollView = HorizontalOnlyScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        // Apply initial highlighting
        SyntaxTheme.applyHighlighting(to: textStorage, language: language)

        // Store reference in coordinator
        context.coordinator.textView = textView

        return scrollView
    }

    static func dismantleNSView(_ scrollView: HorizontalOnlyScrollView, coordinator: Coordinator) {
        coordinator.rehighlightTask?.cancel()
    }

    func updateNSView(_ scrollView: HorizontalOnlyScrollView, context: Context) {
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
            textView.string = text
            coordinator.lastKnownText = text
            coordinator.rehighlight(textView)

            // Clamp restored selectedRanges to new text length to avoid
            // NSRangeException when text is externally updated to a shorter value
            let maxLen = (textView.string as NSString).length
            let clampedRanges = textView.selectedRanges.map { rangeValue -> NSValue in
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

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: HorizontalOnlyScrollView,
        context: Context
    ) -> CGSize? {
        guard let textView = nsView.documentView as? NSTextView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return nil }
        layoutManager.ensureLayout(for: textContainer)
        let usedRect = layoutManager.usedRect(for: textContainer)
        let height = usedRect.height + textView.textContainerInset.height * 2
        return CGSize(width: proposal.width ?? 400, height: height)
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: SyntaxTextView
        var lastKnownText: String
        var language: SyntaxLanguage
        var isUpdatingFromSwiftUI = false
        weak var textView: NSTextView?
        var rehighlightTask: Task<Void, Never>?

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

            // Debounce rehighlighting to avoid per-keystroke lag on large files
            rehighlightTask?.cancel()
            rehighlightTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard !Task.isCancelled, let self, let textView = self.textView else { return }
                self.rehighlight(textView)
            }
        }

        func rehighlight(_ textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            storage.beginEditing()
            SyntaxTheme.applyHighlighting(to: storage, language: language)
            storage.endEditing()
        }
    }
}

// MARK: - HorizontalOnlyScrollView

/// NSScrollView that only handles horizontal scrolling, forwarding vertical
/// scroll events to the parent responder chain (SwiftUI's vertical ScrollView).
class HorizontalOnlyScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) {
            super.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }
}
