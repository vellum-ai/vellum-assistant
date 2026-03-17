import SwiftUI
import AppKit
import VellumAssistantShared

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

        // Configure text container for horizontal scrolling (no line wrap)
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

        // Apply initial highlighting
        SyntaxTheme.applyHighlighting(to: textView.textStorage!, language: language)

        // Store reference in coordinator
        context.coordinator.textView = textView

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        let coordinator = context.coordinator

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
            textView.selectedRanges = selectedRanges
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
        private var rehighlightWorkItem: DispatchWorkItem?

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
            rehighlightWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.rehighlight(textView)
            }
            rehighlightWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: workItem)
        }

        func rehighlight(_ textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            storage.beginEditing()
            SyntaxTheme.applyHighlighting(to: storage, language: language)
            storage.endEditing()
        }
    }
}
