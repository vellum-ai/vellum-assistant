// This component replaces SwiftUI's TextField(axis: .vertical) which does not
// reliably report its intrinsic height on macOS when text wraps to a new line.
// Verified across 10+ approaches (ScrollView, fixedSize, lineLimit, GeometryReader,
// PreferenceKey, NSText notifications, keyDown scroll reset).
// See LUM-233 and the git history of ComposerView.swift for full context.
// Ref: clients/AGENTS.md line 88 — justified exception to SwiftUI preference.

#if os(macOS)
import AppKit
import SwiftUI

struct ComposerTextEditor: NSViewRepresentable {
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

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
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
        textView.textContainer?.lineFragmentPadding = 5
        textView.textContainerInset = NSSize(width: 0, height: 6)
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

        textView.registerForDraggedTypes([.string, .rtf, .rtfd])
        textView.postsFrameChangedNotifications = true

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

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        // Refresh the coordinator's parent so delegate callbacks use current bindings/values.
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? ComposerTextView else { return }

        // Sync text
        if textView.string != text {
            textView.string = text
            textView.scrollRangeToVisible(textView.selectedRange())
        }

        // Sync isEditable
        textView.isEditable = isEditable

        // Sync font and paragraph style
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing
        textView.font = font
        textView.defaultParagraphStyle = paragraphStyle
        textView.typingAttributes = [
            .font: font,
            .paragraphStyle: paragraphStyle,
        ]

        // Sync placeholder
        textView.placeholderString = placeholder

        // Sync textColorOverride
        if let override = textColorOverride {
            textView.textColor = override
        } else {
            textView.textColor = .labelColor
        }

        // Sync callbacks
        textView.cmdEnterToSend = cmdEnterToSend
        textView.onSubmit = onSubmit
        textView.onTab = onTab
        textView.onUpArrow = onUpArrow
        textView.onDownArrow = onDownArrow
        textView.onEscape = onEscape
        textView.onPasteImage = onPasteImage

        // Focus sync (one-directional SwiftUI → AppKit)
        if let window = textView.window {
            if isFocused, textView != window.firstResponder {
                window.makeFirstResponder(textView)
            } else if !isFocused, textView == window.firstResponder {
                window.makeFirstResponder(nil)
            }
        }

        context.coordinator.measureHeight(textView)
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
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
            let contentHeight = ceil(lm.usedRect(for: tc).height + textView.textContainerInset.height * 2)
            let clamped = max(parent.minHeight, min(contentHeight, parent.maxHeight))
            if abs(parent.measuredHeight - clamped) > 0.5 {
                parent.measuredHeight = clamped
            }
        }
    }
}
#endif
