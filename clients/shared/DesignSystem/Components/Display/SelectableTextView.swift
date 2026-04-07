#if os(macOS)
import AppKit
import SwiftUI

/// NSTextView subclass that clears text selection when it resigns first
/// responder. Prevents stale inactive-selection highlights (gray background)
/// from lingering when the user interacts with a different text view.
private final class SelectableNSTextView: NSTextView {
    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result {
            DispatchQueue.main.async { [weak self] in
                self?.setSelectedRange(NSRange(location: 0, length: 0))
            }
        }
        return result
    }
}

/// A read-only, selectable text view that wraps `NSTextView` via `NSViewRepresentable`.
///
/// Provides native macOS text selection (click-drag, Cmd+A, Shift+arrows) and
/// copy (Cmd+C, right-click context menu) without SwiftUI `SelectionOverlay`
/// overhead. Use this instead of `Text` + `.textSelection(.enabled)` inside
/// `LazyVStack` or other lazy containers where `SelectionOverlay` defeats lazy
/// loading and causes performance issues.
///
/// **Performance:** When many instances exist in a `LazyVStack`, set
/// `useExternalSizing: true` and precompute size via
/// ``measureSize(attributedString:lineSpacing:maxWidth:)``, then apply
/// `.frame(width:height:)` so SwiftUI's layout system does not query this
/// view during the layout pass. This avoids an O(N) layout measurement
/// cascade through nested `StackLayout.sizeThatFits` calls.
///
/// For low-instance-count scenarios (e.g., a single thinking block),
/// leave `useExternalSizing` at its default (`false`) and let
/// `sizeThatFits` compute the size normally.
///
/// - SeeAlso: [NSTextView](https://developer.apple.com/documentation/appkit/nstextview)
/// - SeeAlso: [NSViewRepresentable](https://developer.apple.com/documentation/swiftui/nsviewrepresentable)
public struct VSelectableTextView: NSViewRepresentable {
    let attributedString: NSAttributedString
    let maxWidth: CGFloat?
    let lineSpacing: CGFloat
    let tintColor: NSColor
    let useExternalSizing: Bool

    public init(
        attributedString: NSAttributedString,
        maxWidth: CGFloat? = nil,
        lineSpacing: CGFloat = 4,
        tintColor: NSColor = NSColor(VColor.primaryBase),
        useExternalSizing: Bool = false
    ) {
        self.attributedString = attributedString
        self.maxWidth = maxWidth
        self.lineSpacing = lineSpacing
        self.tintColor = tintColor
        self.useExternalSizing = useExternalSizing
    }

    // MARK: - Static Measurement

    /// Shared TextKit 1 stack for height measurement. Reused across all
    /// calls to avoid creating per-instance TextKit stacks just to measure.
    @MainActor private static let measurementTextStorage = NSTextStorage()

    @MainActor private static let measurementLayoutManager: NSLayoutManager = {
        let lm = NSLayoutManager()
        measurementTextStorage.addLayoutManager(lm)
        return lm
    }()

    @MainActor private static let measurementTextContainer: NSTextContainer = {
        let tc = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        tc.lineFragmentPadding = 0
        measurementLayoutManager.addTextContainer(tc)
        return tc
    }()

    /// Precomputes the layout size for a given attributed string at a given
    /// width using a shared TextKit 1 stack. Call from the SwiftUI side
    /// before creating the `NSViewRepresentable`, then apply the result via
    /// `.frame(width:height:)` to avoid `sizeThatFits` being called during
    /// the `LazyVStack` layout pass.
    @MainActor
    public static func measureSize(
        attributedString: NSAttributedString,
        lineSpacing: CGFloat,
        maxWidth: CGFloat
    ) -> CGSize {
        let mutable = NSMutableAttributedString(attributedString: attributedString)
        let fullRange = NSRange(location: 0, length: mutable.length)

        mutable.enumerateAttribute(.paragraphStyle, in: fullRange, options: []) { value, range, _ in
            let existing = (value as? NSParagraphStyle) ?? NSParagraphStyle.default
            let updated = existing.mutableCopy() as! NSMutableParagraphStyle
            updated.lineSpacing = lineSpacing
            mutable.addAttribute(.paragraphStyle, value: updated, range: range)
        }

        measurementTextStorage.setAttributedString(mutable)
        measurementTextContainer.containerSize = NSSize(
            width: maxWidth,
            height: CGFloat.greatestFiniteMagnitude
        )
        measurementLayoutManager.ensureLayout(for: measurementTextContainer)
        let usedRect = measurementLayoutManager.usedRect(for: measurementTextContainer)

        return CGSize(
            width: ceil(min(usedRect.width, maxWidth)),
            height: ceil(usedRect.height)
        )
    }

    // MARK: - NSViewRepresentable

    public func makeNSView(context: Context) -> NSTextView {
        // Build an explicit TextKit 1 stack to avoid the implicit TextKit 2→1
        // downgrade that occurs when accessing `layoutManager` on a default
        // NSTextView (which creates a TextKit 2 view on macOS 12+).
        // Reference: https://developer.apple.com/documentation/appkit/nstextview/1449309-layoutmanager
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)
        let textContainer = NSTextContainer(size: NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        ))
        textContainer.widthTracksTextView = true
        textContainer.lineFragmentPadding = 0
        layoutManager.addTextContainer(textContainer)

        let textView = SelectableNSTextView(frame: .zero, textContainer: textContainer)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.usesFontPanel = false
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainerInset = .zero

        textView.linkTextAttributes = [
            .foregroundColor: tintColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .cursor: NSCursor.pointingHand,
        ]

        context.coordinator.applyAttributedString(attributedString, lineSpacing: lineSpacing, to: textView)
        return textView
    }

    public func updateNSView(_ textView: NSTextView, context: Context) {
        let coordinator = context.coordinator
        guard coordinator.lastAttributedString != attributedString
            || coordinator.lastLineSpacing != lineSpacing else { return }
        if useExternalSizing {
            coordinator.scheduleAttributedStringApply(attributedString, lineSpacing: lineSpacing, to: textView)
        } else {
            coordinator.cancelPendingApply()
            coordinator.applyAttributedString(attributedString, lineSpacing: lineSpacing, to: textView)
        }
    }

    /// When `useExternalSizing` is `true`, returns `nil` so SwiftUI uses
    /// the precomputed `.frame(width:height:)` from the caller. When `false`,
    /// computes size using the view's own TextKit stack.
    /// Reference: https://developer.apple.com/documentation/swiftui/nsviewrepresentable/sizethatfits(_:nsview:context:)-33z4e
    public func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView textView: NSTextView,
        context: Context
    ) -> CGSize? {
        if useExternalSizing { return nil }

        let width = maxWidth ?? proposal.width ?? 400
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return nil }

        textContainer.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let usedRect = layoutManager.usedRect(for: textContainer)
        return CGSize(width: ceil(min(usedRect.width, width)), height: ceil(usedRect.height))
    }

    public static func dismantleNSView(_ textView: NSTextView, coordinator: Coordinator) {
        textView.textStorage?.setAttributedString(NSAttributedString())
        coordinator.reset()
    }

    public func makeCoordinator() -> Coordinator { Coordinator() }

    public final class Coordinator {
        var lastAttributedString: NSAttributedString?
        var lastLineSpacing: CGFloat = 0
        private var pendingAttributedString: NSAttributedString?
        private var pendingLineSpacing: CGFloat?
        private weak var pendingTextView: NSTextView?
        private var hasScheduledApply = false

        func reset() {
            lastAttributedString = nil
            lastLineSpacing = 0
            pendingAttributedString = nil
            pendingLineSpacing = nil
            pendingTextView = nil
            hasScheduledApply = false
        }

        func cancelPendingApply() {
            pendingAttributedString = nil
            pendingLineSpacing = nil
            pendingTextView = nil
        }

        func scheduleAttributedStringApply(
            _ attributedString: NSAttributedString,
            lineSpacing: CGFloat,
            to textView: NSTextView
        ) {
            pendingAttributedString = attributedString
            pendingLineSpacing = lineSpacing
            pendingTextView = textView
            guard !hasScheduledApply else { return }
            hasScheduledApply = true

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.hasScheduledApply = false
                guard let textView = self.pendingTextView,
                      let attributedString = self.pendingAttributedString,
                      let lineSpacing = self.pendingLineSpacing else { return }
                self.pendingTextView = nil
                self.pendingAttributedString = nil
                self.pendingLineSpacing = nil
                self.applyAttributedString(attributedString, lineSpacing: lineSpacing, to: textView)
            }
        }

        func applyAttributedString(
            _ attributedString: NSAttributedString,
            lineSpacing: CGFloat,
            to textView: NSTextView
        ) {
            lastAttributedString = attributedString
            lastLineSpacing = lineSpacing

            guard let textStorage = textView.textStorage else { return }

            let mutable = NSMutableAttributedString(attributedString: attributedString)
            let fullRange = NSRange(location: 0, length: mutable.length)

            mutable.enumerateAttribute(.paragraphStyle, in: fullRange, options: []) { value, range, _ in
                let existing = (value as? NSParagraphStyle) ?? NSParagraphStyle.default
                let updated = existing.mutableCopy() as! NSMutableParagraphStyle
                updated.lineSpacing = lineSpacing
                mutable.addAttribute(.paragraphStyle, value: updated, range: range)
            }

            textStorage.setAttributedString(mutable)
        }
    }
}
#endif
