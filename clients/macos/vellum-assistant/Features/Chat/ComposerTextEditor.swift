#if os(macOS)
import AppKit
import SwiftUI

/// NSScrollView subclass that reports intrinsic content size based on
/// its document view's text layout height. This lets SwiftUI size the
/// view correctly without the scroll view expanding to fill all
/// proposed space.
///
/// Ref: https://developer.apple.com/documentation/appkit/nsview/intrinsiccontentsize
fileprivate final class IntrinsicScrollView: NSScrollView {
    var contentHeight: CGFloat = 0 {
        didSet {
            if abs(contentHeight - oldValue) > 0.5 {
                invalidateIntrinsicContentSize()
            }
        }
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: contentHeight)
    }
}

/// NSViewRepresentable wrapper for `ComposerTextView`, replacing SwiftUI's
/// `TextField(axis: .vertical)` which suffers from O(n) performance
/// degradation in `SelectionOverlay.updateNSView` when text contains many
/// paragraphs.
///
/// Ref: https://developer.apple.com/documentation/appkit/nstextview
struct ComposerTextEditor: NSViewRepresentable {
    /// Inset values matching NSTextView's internal layout offsets.
    /// Used to align SwiftUI overlays (ghost text, slash highlighting)
    /// with the NSTextView's rendered text position.
    static let textInsetX: CGFloat = 5   // lineFragmentPadding
    static let textInsetY: CGFloat = 6   // textContainerInset.height

    @Binding var text: String
    @Binding var measuredHeight: CGFloat
    @Binding var isFocused: Bool

    let font: NSFont
    let lineSpacing: CGFloat
    let insertionPointColor: NSColor
    let minHeight: CGFloat
    let maxHeight: CGFloat
    let placeholder: String
    let isEditable: Bool
    let cmdEnterToSend: Bool
    var textColorOverride: NSColor? = nil
    var onSubmit: (() -> Void)? = nil
    var onTab: (() -> Bool)? = nil
    var onUpArrow: (() -> Bool)? = nil
    var onDownArrow: (() -> Bool)? = nil
    var onEscape: (() -> Bool)? = nil
    var onPasteImage: (() -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> IntrinsicScrollView {
        let scrollView = IntrinsicScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay

        let textView = ComposerTextView()
        textView.isRichText = false
        textView.importsGraphics = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.lineFragmentPadding = Self.textInsetX
        textView.textContainerInset = NSSize(width: 0, height: Self.textInsetY)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.font = font
        textView.insertionPointColor = insertionPointColor

        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing
        textView.defaultParagraphStyle = paragraphStyle
        textView.typingAttributes = [
            .font: font,
            .paragraphStyle: paragraphStyle,
        ]

        textView.postsFrameChangedNotifications = true

        // Strip all drag types so the NSTextView doesn't intercept file drops
        // (which would insert file paths as text). File drops are handled by
        // SwiftUI's .onDrop modifier on the composer container.
        textView.unregisterDraggedTypes()

        scrollView.contentHeight = minHeight
        scrollView.documentView = textView
        textView.delegate = context.coordinator

        let coordinator = context.coordinator

        coordinator.frameObserver = NotificationCenter.default.addObserver(
            forName: NSView.frameDidChangeNotification,
            object: textView,
            queue: .main
        ) { [weak coordinator] _ in
            coordinator?.measureHeight(textView)
        }

        scrollView.contentView.postsBoundsChangedNotifications = true

        coordinator.boundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: scrollView.contentView,
            queue: .main
        ) { [weak coordinator] _ in
            coordinator?.measureHeight(textView)
        }

        DispatchQueue.main.async {
            coordinator.measureHeight(textView)
        }

        return scrollView
    }

    func updateNSView(_ scrollView: IntrinsicScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? ComposerTextView else { return }

        if textView.string != text {
            textView.string = text
            textView.scrollRangeToVisible(textView.selectedRange())
        }

        textView.isEditable = isEditable

        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing
        textView.font = font
        textView.defaultParagraphStyle = paragraphStyle
        textView.typingAttributes = [
            .font: font,
            .paragraphStyle: paragraphStyle,
        ]

        textView.placeholderString = placeholder

        if let override = textColorOverride {
            textView.textColor = override
        } else {
            textView.textColor = .labelColor
        }

        textView.cmdEnterToSend = cmdEnterToSend
        textView.onSubmit = onSubmit
        textView.onTab = onTab
        textView.onUpArrow = onUpArrow
        textView.onDownArrow = onDownArrow
        textView.onEscape = onEscape
        textView.onPasteImage = onPasteImage
        textView.onFocusChanged = { [weak coordinator = context.coordinator] focused in
            guard let coordinator, coordinator.parent.isFocused != focused else { return }
            coordinator.parent.isFocused = focused
        }

        // Re-strip drag types in case TextKit re-registered them during
        // font or attribute updates above.
        textView.unregisterDraggedTypes()

        if let window = textView.window {
            if isFocused, textView != window.firstResponder {
                window.makeFirstResponder(textView)
            } else if !isFocused, textView == window.firstResponder {
                window.makeFirstResponder(nil)
            }
        }

        context.coordinator.measureHeight(textView)
    }

    static func dismantleNSView(_ scrollView: IntrinsicScrollView, coordinator: Coordinator) {
        if let frameObserver = coordinator.frameObserver {
            NotificationCenter.default.removeObserver(frameObserver)
            coordinator.frameObserver = nil
        }
        if let boundsObserver = coordinator.boundsObserver {
            NotificationCenter.default.removeObserver(boundsObserver)
            coordinator.boundsObserver = nil
        }
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextEditor
        var frameObserver: NSObjectProtocol?
        var boundsObserver: NSObjectProtocol?

        init(parent: ComposerTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let newText = textView.string
            if parent.text != newText {
                parent.text = newText
            }
            measureHeight(textView)
        }

        func textDidBeginEditing(_ notification: Notification) {
            // Focus state is primarily driven by ComposerTextView's
            // becomeFirstResponder / resignFirstResponder callbacks.
            // This delegate fires only once editing begins (on first
            // keyDown), so it serves as a secondary sync only.
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textDidEndEditing(_ notification: Notification) {
            if parent.isFocused {
                parent.isFocused = false
            }
        }

        func measureHeight(_ textView: NSTextView) {
            guard let lm = textView.layoutManager, let tc = textView.textContainer else { return }
            lm.ensureLayout(for: tc)
            let usedHeight = ceil(lm.usedRect(for: tc).height)
            let contentHeight = usedHeight + textView.textContainerInset.height * 2
            let clamped = max(parent.minHeight, min(contentHeight, parent.maxHeight))
            if abs(parent.measuredHeight - clamped) > 0.5 {
                parent.measuredHeight = clamped
            }
            // Update the scroll view's intrinsic content size so SwiftUI
            // sizes the NSViewRepresentable correctly.
            if let scrollView = textView.enclosingScrollView as? IntrinsicScrollView {
                scrollView.contentHeight = clamped
            }
        }
    }
}
#endif
