#if os(macOS)
import AppKit
import SwiftUI
import VellumAssistantShared

// MARK: - Bridge Event & Command Contracts

/// Events emitted by the AppKit text view coordinator to notify the SwiftUI layer.
/// All callbacks are owned by the coordinator — the view installs them once in
/// `makeNSView` and they remain stable for the lifetime of the representable.
struct ComposerBridgeEvents {
    /// Fired when the text content changes. Carries the new text value.
    var textChanged: ((String) -> Void)?
    /// Fired when the selection/cursor position changes. Carries UTF-16 offset.
    var selectionChanged: ((Int) -> Void)?
    /// Fired when the text view gains or loses first-responder status.
    var focusChanged: ((Bool) -> Void)?
    /// Fired when the user presses Return in a "send" configuration.
    var submitRequested: (() -> Void)?
}

/// One-way commands that the SwiftUI layer can push into the AppKit text view.
/// The coordinator processes these during `updateNSView` and clears consumed
/// values so they don't re-fire on subsequent SwiftUI render passes.
final class ComposerBridgeCommands {
    /// When non-nil, the coordinator sets the text view's string to this value
    /// and clears the field. Only applied when the value differs from the
    /// current text view content to avoid TextKit re-layout churn.
    var pendingSetText: String?

    /// When non-nil, the coordinator updates the text view's `isEditable`.
    var pendingSetEditable: Bool?

    /// When non-nil, the coordinator requests or resigns first-responder status.
    /// Queued to the next main-turn to avoid mutating window state during
    /// `updateNSView`.
    var pendingRequestFocus: Bool?

    /// When non-nil, the coordinator performs an undoable text replacement at
    /// the given range. Used for emoji insertion and similar programmatic edits.
    var pendingReplaceRange: (range: NSRange, replacement: String)?
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
/// ``IntrinsicScrollView``. Communicates with SwiftUI exclusively through
/// the ``ComposerBridgeEvents`` (AppKit -> SwiftUI) and
/// ``ComposerBridgeCommands`` (SwiftUI -> AppKit) contracts.
///
/// The coordinator never writes to SwiftUI `@Binding` properties directly
/// from AppKit callbacks. Instead, events flow through the bridge callbacks
/// and the view layer decides how to translate them into state updates.
///
/// Ref: https://developer.apple.com/documentation/swiftui/nsviewrepresentable
struct ComposerTextEditor: NSViewRepresentable {
    /// Inset values matching NSTextView's internal layout offsets.
    /// Used to align SwiftUI overlays (ghost text, slash highlighting)
    /// with the NSTextView's rendered text position.
    static let textInsetX: CGFloat = 5   // lineFragmentPadding
    static let textInsetY: CGFloat = 6   // textContainerInset.height

    let font: NSFont
    let lineSpacing: CGFloat
    let insertionPointColor: NSColor
    let minHeight: CGFloat
    let maxHeight: CGFloat
    let cmdEnterToSend: Bool
    var textColorOverride: NSColor? = nil
    var onTab: (() -> Bool)? = nil
    var onUpArrow: (() -> Bool)? = nil
    var onDownArrow: (() -> Bool)? = nil
    var onEscape: (() -> Bool)? = nil
    var onPasteImage: (() -> Void)? = nil
    var shouldOverrideReturn: (() -> Bool)? = nil

    /// Explicit bridge events — the coordinator fires these instead of
    /// writing to `@Binding` properties.
    let bridgeEvents: ComposerBridgeEvents

    /// Explicit bridge commands — the view layer writes pending commands
    /// here and the coordinator consumes them in `updateNSView`.
    let bridgeCommands: ComposerBridgeCommands

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

        // Build an explicit TextKit 1 stack to avoid the implicit TextKit 2->1
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

        let coordinator = context.coordinator
        let commands = bridgeCommands

        // --- Process one-way commands ---

        // setText command
        if let pendingText = commands.pendingSetText {
            commands.pendingSetText = nil
            if textView.string != pendingText {
                textView.string = pendingText
                textView.scrollRangeToVisible(textView.selectedRange())
            }
        }

        // setEditable command
        if let pendingEditable = commands.pendingSetEditable {
            commands.pendingSetEditable = nil
            textView.isEditable = pendingEditable
        }

        // replaceRange command
        if let pending = commands.pendingReplaceRange {
            commands.pendingReplaceRange = nil
            textView.insertText(pending.replacement, replacementRange: pending.range)
        }

        // Guard attribute updates behind change checks to avoid triggering
        // redundant TextKit re-layouts during the SwiftUI render cycle.
        // Each keystroke fires textDidChange -> bridge event -> updateNSView;
        // unconditionally re-stamping font/color/typingAttributes here would
        // cause a layout pass on every character, which can leave glyphs
        // un-drawn until the *next* display cycle (appearing invisible).
        // Ref: WWDC 2022 "Use SwiftUI with AppKit" -- only update changed props.
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

        textView.cmdEnterToSend = cmdEnterToSend
        textView.onSubmit = bridgeEvents.submitRequested
        textView.onTab = onTab
        textView.onUpArrow = onUpArrow
        textView.onDownArrow = onDownArrow
        textView.onEscape = onEscape
        textView.onPasteImage = onPasteImage
        textView.shouldOverrideReturn = shouldOverrideReturn
        textView.onFocusChanged = { [weak coordinator] focused in
            coordinator?.scheduleFocusEvent(focused)
        }

        // Re-strip drag types in case TextKit re-registered them during
        // font or attribute updates above.
        textView.unregisterDraggedTypes()

        // requestFocus command — queued to next main turn as a single
        // bridge policy instead of scattered DispatchQueue.main.async calls.
        if let shouldFocus = commands.pendingRequestFocus {
            commands.pendingRequestFocus = nil
            if let window = textView.window {
                coordinator.scheduleFirstResponderUpdate(
                    in: window,
                    textView: textView,
                    shouldFocus: shouldFocus
                )
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

        // Track last-applied values so updateNSView only touches the text
        // storage when something actually changed.
        var lastAppliedFont: NSFont?
        var lastAppliedLineSpacing: CGFloat?
        var lastAppliedTextColor: NSColor?
        var pendingFocusEventValue: Bool?
        var pendingFirstResponderValue: Bool?
        weak var textView: ComposerTextView?

        init(parent: ComposerTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let newText = textView.string
            // Fire bridge event instead of writing to @Binding directly
            parent.bridgeEvents.textChanged?(newText)

            let pos = textView.selectedRange().location
            parent.bridgeEvents.selectionChanged?(pos)

            measureHeight(textView)
        }

        func textDidBeginEditing(_ notification: Notification) {
            // Focus state is primarily driven by ComposerTextView's
            // becomeFirstResponder / resignFirstResponder callbacks.
            // This delegate fires only once editing begins (on first
            // keyDown), so it serves as a secondary sync only.
            scheduleFocusEvent(true)
        }

        func textDidEndEditing(_ notification: Notification) {
            scheduleFocusEvent(false)
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let pos = textView.selectedRange().location
            // Fire bridge event instead of writing to @Binding directly
            parent.bridgeEvents.selectionChanged?(pos)
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

        /// Schedules a focus event to fire on the next main turn.
        /// Coalesces rapid focus changes (e.g. becomeFirstResponder
        /// followed immediately by resignFirstResponder) by checking
        /// the intended value hasn't been superseded.
        func scheduleFocusEvent(_ focused: Bool) {
            pendingFocusEventValue = focused
            DispatchQueue.main.async { [weak self] in
                guard let self, self.pendingFocusEventValue == focused else { return }
                self.pendingFocusEventValue = nil
                self.parent.bridgeEvents.focusChanged?(focused)
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
