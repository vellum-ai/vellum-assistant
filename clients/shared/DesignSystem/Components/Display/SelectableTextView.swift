#if os(macOS)
import AppKit
import SwiftUI

/// A read-only, selectable text view that wraps `NSTextView` via `NSViewRepresentable`.
///
/// Provides native macOS text selection (click-drag, Cmd+A, Shift+arrows) and
/// copy (Cmd+C, right-click context menu) without SwiftUI `SelectionOverlay`
/// overhead. Use this instead of `Text` + `.textSelection(.enabled)` inside
/// `LazyVStack` or other lazy containers where `SelectionOverlay` defeats lazy
/// loading and causes performance issues.
///
/// - SeeAlso: [NSTextView](https://developer.apple.com/documentation/appkit/nstextview)
/// - SeeAlso: [NSViewRepresentable](https://developer.apple.com/documentation/swiftui/nsviewrepresentable)
public struct VSelectableTextView: NSViewRepresentable {
    let attributedString: NSAttributedString
    let maxWidth: CGFloat?
    let lineSpacing: CGFloat
    let tintColor: NSColor

    public init(
        attributedString: NSAttributedString,
        maxWidth: CGFloat? = nil,
        lineSpacing: CGFloat = 4,
        tintColor: NSColor = NSColor(VColor.primaryBase)
    ) {
        self.attributedString = attributedString
        self.maxWidth = maxWidth
        self.lineSpacing = lineSpacing
        self.tintColor = tintColor
    }

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

        let textView = NSTextView(frame: .zero, textContainer: textContainer)
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
        coordinator.applyAttributedString(attributedString, lineSpacing: lineSpacing, to: textView)
    }

    public func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView textView: NSTextView,
        context: Context
    ) -> CGSize? {
        let width = maxWidth ?? proposal.width ?? 400
        let coordinator = context.coordinator

        // Return cached size when the content and available width haven't changed.
        if let cached = coordinator.cachedHeight, coordinator.cachedWidth == width {
            return CGSize(width: ceil(coordinator.cachedContentWidth ?? width), height: cached)
        }

        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return nil }

        textContainer.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let usedRect = layoutManager.usedRect(for: textContainer)

        let resultHeight = ceil(usedRect.height)
        let resultWidth = ceil(min(usedRect.width, width))
        coordinator.cachedWidth = width
        coordinator.cachedHeight = resultHeight
        coordinator.cachedContentWidth = resultWidth
        return CGSize(width: resultWidth, height: resultHeight)
    }

    public func makeCoordinator() -> Coordinator { Coordinator() }

    public final class Coordinator {
        var lastAttributedString: NSAttributedString?
        var lastLineSpacing: CGFloat = 0
        var cachedWidth: CGFloat?
        var cachedHeight: CGFloat?
        var cachedContentWidth: CGFloat?

        func applyAttributedString(
            _ attributedString: NSAttributedString,
            lineSpacing: CGFloat,
            to textView: NSTextView
        ) {
            lastAttributedString = attributedString
            lastLineSpacing = lineSpacing

            // Invalidate cached size when content changes.
            cachedWidth = nil
            cachedHeight = nil
            cachedContentWidth = nil

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
