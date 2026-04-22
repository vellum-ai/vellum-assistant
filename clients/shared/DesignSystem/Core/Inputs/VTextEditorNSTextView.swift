#if os(macOS)
import AppKit
import SwiftUI

/// `NSViewRepresentable` wrapping `NSTextView` in an `NSScrollView` for
/// multi-line text entry with pixel-perfect control over text container
/// insets. Used by `VTextEditor` on macOS; iOS uses SwiftUI's native
/// `TextEditor`.
///
/// SwiftUI's `TextEditor` on macOS does not expose
/// `NSTextContainer.lineFragmentPadding` or `NSTextView.textContainerInset`
/// and their effective values drift across OS versions, making it
/// impossible to align a sibling placeholder overlay with the rendered
/// caret. Bridging directly to AppKit lets us fix both values explicitly
/// so overlay geometry matches the text view's internal layout.
///
/// References:
/// - [`NSTextView`](https://developer.apple.com/documentation/appkit/nstextview)
/// - [`NSTextContainer.lineFragmentPadding`](https://developer.apple.com/documentation/uikit/nstextcontainer/linefragmentpadding)
/// - [`NSTextView.textContainerInset`](https://developer.apple.com/documentation/appkit/nstextview/1449187-textcontainerinset)
struct VTextEditorNSTextView: NSViewRepresentable {
    /// Horizontal inset applied to each line fragment. Placeholder overlays
    /// in the parent view use this same value so text and placeholder are
    /// horizontally aligned.
    static let textInsetX: CGFloat = 5

    /// Vertical inset applied to the top and bottom of the text container.
    /// Placeholder overlays use this same value so text and placeholder are
    /// vertically aligned.
    static let textInsetY: CGFloat = 6

    @Binding var text: String

    /// Parent-driven focus intent. When this transitions from `false` to
    /// `true` the coordinator requests first-responder status for the text
    /// view. Focus changes originating from the text view (click, tab
    /// navigation) flow back via `onFocusChanged`.
    let shouldFocus: Bool

    let font: NSFont
    let textColor: NSColor
    let accessibilityLabel: String
    var onFocusChanged: ((Bool) -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        // `VTextEditor` renders its focus state via `.vInputChrome`; suppress
        // the native AppKit focus ring on both the scroll view and the
        // embedded text view so only one border is drawn.
        // https://developer.apple.com/documentation/appkit/nsview/1483335-focusringtype
        scrollView.focusRingType = .none

        // Build an explicit TextKit 1 stack to avoid the implicit TextKit 2→1
        // downgrade that occurs when accessing `layoutManager` on a default
        // NSTextView (macOS 12+). The downgrade causes visual glitches where
        // typed text can be invisible even though the caret renders.
        // Reference: https://developer.apple.com/documentation/appkit/nstextview/1449309-layoutmanager
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        // Confine glyph generation to the visible rect so attaching the
        // text view to its scroll view does not force full-document layout
        // on the main thread.
        // https://developer.apple.com/documentation/appkit/nslayoutmanager/allowsnoncontiguouslayout
        layoutManager.allowsNonContiguousLayout = true
        textStorage.addLayoutManager(layoutManager)

        let textContainer = NSTextContainer(size: NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        ))
        textContainer.widthTracksTextView = true
        textContainer.lineFragmentPadding = Self.textInsetX
        layoutManager.addTextContainer(textContainer)

        let textView = NSTextView(frame: .zero, textContainer: textContainer)
        textView.isRichText = false
        textView.importsGraphics = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.focusRingType = .none
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = true
        textView.textContainerInset = NSSize(width: 0, height: Self.textInsetY)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.autoresizingMask = [.width]
        textView.font = font
        textView.textColor = textColor
        textView.insertionPointColor = textColor
        textView.allowsUndo = true
        textView.typingAttributes = [
            .font: font,
            .foregroundColor: textColor,
        ]
        textView.setAccessibilityLabel(accessibilityLabel)

        // Drop file drag-types so the text view does not intercept file
        // drops (which would insert file paths as text). File drops are
        // handled by the enclosing SwiftUI view via `.onDrop` if needed.
        textView.unregisterDraggedTypes()

        scrollView.documentView = textView
        textView.delegate = context.coordinator
        context.coordinator.textView = textView

        // Seed initial content before SwiftUI's first `updateNSView` call so
        // the first measured height reflects the real text.
        if !text.isEmpty {
            textView.string = text
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let textView = scrollView.documentView as? NSTextView else { return }

        if textView.string != text {
            textView.string = text
        }

        let fontChanged = coordinator.lastAppliedFont != font
        let textColorChanged = coordinator.lastAppliedTextColor != textColor

        if fontChanged {
            coordinator.lastAppliedFont = font
            textView.font = font
        }

        if textColorChanged {
            coordinator.lastAppliedTextColor = textColor
            textView.textColor = textColor
            textView.insertionPointColor = textColor
        }

        // `typingAttributes` governs the attributes applied to newly typed
        // characters and is not recomputed from `font` / `textColor` — it
        // must be re-seeded whenever either input changes, or text typed
        // after an appearance-mode switch (light ↔ dark) will carry the
        // stale foreground color.
        if fontChanged || textColorChanged {
            textView.typingAttributes = [
                .font: font,
                .foregroundColor: textColor,
            ]
        }

        if coordinator.lastAccessibilityLabel != accessibilityLabel {
            coordinator.lastAccessibilityLabel = accessibilityLabel
            textView.setAccessibilityLabel(accessibilityLabel)
        }

        // Wait until the text view is in a window before attempting to set
        // first responder. If the window is nil (during view hierarchy
        // transitions), leave `lastShouldFocus` stale so the next
        // `updateNSView` retries the request.
        if coordinator.lastShouldFocus != shouldFocus {
            if let window = textView.window {
                coordinator.lastShouldFocus = shouldFocus
                if shouldFocus, window.firstResponder !== textView {
                    window.makeFirstResponder(textView)
                } else if !shouldFocus, window.firstResponder === textView {
                    window.makeFirstResponder(nil)
                }
            }
        }
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
        // NSTextView registers text-edit undo actions on the window's undo
        // manager with itself as an unsafe-unretained target — a later
        // cmd+z after the view is torn down dereferences a freed pointer.
        // Purge our actions before the view is deallocated.
        if let textView = scrollView.documentView as? NSTextView {
            textView.breakUndoCoalescing()
            textView.undoManager?.removeAllActions(withTarget: textView)
            textView.delegate = nil
        }
        coordinator.textView = nil
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: VTextEditorNSTextView
        weak var textView: NSTextView?

        var lastAppliedFont: NSFont?
        var lastAppliedTextColor: NSColor?
        var lastAccessibilityLabel: String?
        var lastShouldFocus: Bool?

        init(parent: VTextEditorNSTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let newText = textView.string
            if parent.text != newText {
                parent.text = newText
            }
        }

        func textDidBeginEditing(_ notification: Notification) {
            parent.onFocusChanged?(true)
        }

        func textDidEndEditing(_ notification: Notification) {
            parent.onFocusChanged?(false)
        }
    }
}
#endif
