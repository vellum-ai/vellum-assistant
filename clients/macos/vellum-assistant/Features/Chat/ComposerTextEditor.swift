#if os(macOS)
import AppKit
import SwiftUI
import VellumAssistantShared

/// Proxy object that allows callers to programmatically replace text
/// in the composer's underlying NSTextView. Uses `insertText(_:replacementRange:)`
/// so replacements participate in the undo stack.
final class TextReplacementProxy {
    var replaceText: ((NSRange, String) -> Void)?
}

/// NSScrollView subclass that reports intrinsic content size based on
/// its document view's text layout height. This lets SwiftUI size the
/// view correctly without the scroll view expanding to fill all
/// proposed space.
///
/// Ref: https://developer.apple.com/documentation/appkit/nsview/intrinsiccontentsize
final class IntrinsicScrollView: NSScrollView {
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

/// NSViewRepresentable wrapper that hosts a ``ComposerTextView`` inside an
/// ``IntrinsicScrollView``. Manages two-way text and focus binding with
/// SwiftUI, height measurement via TextKit layout, and callback wiring
/// for key events, image paste, and submit actions.
///
/// Ref: https://developer.apple.com/documentation/swiftui/nsviewrepresentable
struct ComposerTextEditor: NSViewRepresentable {
    /// Inset values matching NSTextView's internal layout offsets.
    /// Used to align SwiftUI overlays (ghost text, slash highlighting)
    /// with the NSTextView's rendered text position.
    static let textInsetX: CGFloat = 5   // lineFragmentPadding
    static let textInsetY: CGFloat = 6   // textContainerInset.height

    @Binding var text: String
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
    var shouldOverrideReturn: (() -> Bool)? = nil
    @Binding var cursorPosition: Int
    var textReplacer: TextReplacementProxy? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> IntrinsicScrollView {
        let scrollView = IntrinsicScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay

        // Build an explicit TextKit 1 stack to avoid the implicit TextKit 2→1
        // downgrade that occurs when accessing `layoutManager` on a default
        // NSTextView (macOS 12+). The downgrade causes visual glitches where
        // typed text is invisible even though the insertion point renders.
        // Reference: https://developer.apple.com/documentation/appkit/nstextview/1449309-layoutmanager
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)
        let textContainer = NSTextContainer(size: NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        ))
        textContainer.widthTracksTextView = true
        textContainer.lineFragmentPadding = Self.textInsetX
        layoutManager.addTextContainer(textContainer)

        let textView = ComposerTextView(frame: .zero, textContainer: textContainer)
        context.coordinator.textView = textView
        textView.isRichText = false
        textView.importsGraphics = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.textContainerInset = NSSize(width: 0, height: Self.textInsetY)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = [.width]
        textView.font = font
        textView.insertionPointColor = insertionPointColor
        textView.allowsUndo = true
        textView.isContinuousSpellCheckingEnabled = true
        textView.isAutomaticTextCompletionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false

        let defaultColor = NSColor(VColor.contentDefault)
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing
        textView.defaultParagraphStyle = paragraphStyle
        textView.typingAttributes = [
            .font: font,
            .paragraphStyle: paragraphStyle,
            .foregroundColor: defaultColor,
        ]

        textView.postsFrameChangedNotifications = true

        // Strip all drag types so the NSTextView doesn't intercept file drops
        // (which would insert file paths as text). File drops are handled by
        // SwiftUI's .onDrop modifier on the composer container.
        textView.unregisterDraggedTypes()

        scrollView.contentHeight = minHeight
        scrollView.documentView = textView
        textView.delegate = context.coordinator

        if let proxy = textReplacer {
            proxy.replaceText = { [weak textView] range, replacement in
                textView?.insertText(replacement, replacementRange: range)
            }
        }

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

        // Guard attribute updates behind change checks to avoid triggering
        // redundant TextKit re-layouts during the SwiftUI render cycle.
        // Each keystroke fires textDidChange → binding update → updateNSView;
        // unconditionally re-stamping font/color/typingAttributes here would
        // cause a layout pass on every character, which can leave glyphs
        // un-drawn until the *next* display cycle (appearing invisible).
        // Ref: WWDC 2022 "Use SwiftUI with AppKit" — only update changed props.
        let coordinator = context.coordinator
        let textColor = textColorOverride ?? NSColor(VColor.contentDefault)

        let fontChanged = coordinator.lastAppliedFont != font
            || coordinator.lastAppliedLineSpacing != lineSpacing
        let colorChanged = coordinator.lastAppliedTextColor != textColor

        if fontChanged {
            coordinator.lastAppliedFont = font
            coordinator.lastAppliedLineSpacing = lineSpacing
            let paragraphStyle = NSMutableParagraphStyle()
            paragraphStyle.lineSpacing = lineSpacing
            textView.font = font
            textView.defaultParagraphStyle = paragraphStyle
        }

        if fontChanged || colorChanged {
            coordinator.lastAppliedTextColor = textColor
            textView.textColor = textColor
            textView.typingAttributes = [
                .font: font,
                .paragraphStyle: textView.defaultParagraphStyle ?? NSParagraphStyle.default,
                .foregroundColor: textColor,
            ]
        }

        textView.placeholderString = placeholder

        textView.cmdEnterToSend = cmdEnterToSend
        textView.onSubmit = onSubmit
        textView.onTab = onTab
        textView.onUpArrow = onUpArrow
        textView.onDownArrow = onDownArrow
        textView.onEscape = onEscape
        textView.onPasteImage = onPasteImage
        textView.shouldOverrideReturn = shouldOverrideReturn
        textView.onFocusChanged = { [weak coordinator = context.coordinator] focused in
            coordinator?.scheduleFocusBindingUpdate(focused)
        }

        if let proxy = textReplacer {
            proxy.replaceText = { [weak textView] range, replacement in
                textView?.insertText(replacement, replacementRange: range)
            }
        }

        // Re-strip drag types in case TextKit re-registered them during
        // font or attribute updates above.
        textView.unregisterDraggedTypes()

        if let window = textView.window {
            coordinator.scheduleFirstResponderUpdate(
                in: window,
                textView: textView,
                shouldFocus: isFocused
            )
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

        // Track last-applied values so updateNSView only touches the text
        // storage when something actually changed.
        var lastAppliedFont: NSFont?
        var lastAppliedLineSpacing: CGFloat?
        var lastAppliedTextColor: NSColor?
        var pendingFocusBindingValue: Bool?
        var pendingFirstResponderValue: Bool?
        weak var textView: ComposerTextView?

        init(parent: ComposerTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let newText = textView.string
            if parent.text != newText {
                parent.text = newText
            }
            let pos = textView.selectedRange().location
            if parent.cursorPosition != pos {
                parent.cursorPosition = pos
            }
            measureHeight(textView)
        }

        func textDidBeginEditing(_ notification: Notification) {
            // Focus state is primarily driven by ComposerTextView's
            // becomeFirstResponder / resignFirstResponder callbacks.
            // This delegate fires only once editing begins (on first
            // keyDown), so it serves as a secondary sync only.
            scheduleFocusBindingUpdate(true)
        }

        func textDidEndEditing(_ notification: Notification) {
            scheduleFocusBindingUpdate(false)
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let pos = textView.selectedRange().location
            if parent.cursorPosition != pos {
                parent.cursorPosition = pos
            }
        }

        func measureHeight(_ textView: NSTextView) {
            guard let lm = textView.layoutManager, let tc = textView.textContainer else { return }
            lm.ensureLayout(for: tc)
            let usedHeight = ceil(lm.usedRect(for: tc).height)
            let contentHeight = usedHeight + textView.textContainerInset.height * 2
            let clamped = max(parent.minHeight, min(contentHeight, parent.maxHeight))
            // Update the scroll view's intrinsic content size so SwiftUI
            // sizes the NSViewRepresentable correctly without bouncing the
            // measured height back through SwiftUI state during view updates.
            if let scrollView = textView.enclosingScrollView as? IntrinsicScrollView {
                scrollView.contentHeight = clamped
            }
        }

        func scheduleFocusBindingUpdate(_ focused: Bool) {
            pendingFocusBindingValue = focused
            DispatchQueue.main.async { [weak self] in
                guard let self, self.pendingFocusBindingValue == focused else { return }
                self.pendingFocusBindingValue = nil
                if self.parent.isFocused != focused {
                    self.parent.isFocused = focused
                }
            }
        }

        func scheduleFirstResponderUpdate(
            in window: NSWindow,
            textView: ComposerTextView,
            shouldFocus: Bool
        ) {
            pendingFirstResponderValue = shouldFocus
            DispatchQueue.main.async { [weak self, weak window, weak textView] in
                guard let self, self.pendingFirstResponderValue == shouldFocus else { return }
                self.pendingFirstResponderValue = nil
                guard let window, let textView else { return }
                if shouldFocus, textView != window.firstResponder {
                    window.makeFirstResponder(textView)
                } else if !shouldFocus, textView == window.firstResponder {
                    window.makeFirstResponder(nil)
                }
            }
        }
    }
}
#endif
