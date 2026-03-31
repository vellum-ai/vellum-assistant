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
public struct SelectableTextView: NSViewRepresentable {
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
        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.usesFontPanel = false
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]

        // Zero out padding so the text aligns with surrounding SwiftUI content.
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true

        // Link appearance: use the tint color and open in default browser.
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
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return nil }

        let width = maxWidth ?? proposal.width ?? 400
        textContainer.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let usedRect = layoutManager.usedRect(for: textContainer)
        return CGSize(width: width, height: ceil(usedRect.height))
    }

    public func makeCoordinator() -> Coordinator { Coordinator() }

    public final class Coordinator {
        var lastAttributedString: NSAttributedString?
        var lastLineSpacing: CGFloat = 0

        func applyAttributedString(
            _ attributedString: NSAttributedString,
            lineSpacing: CGFloat,
            to textView: NSTextView
        ) {
            lastAttributedString = attributedString
            lastLineSpacing = lineSpacing

            guard let textStorage = textView.textStorage else { return }

            // Apply the attributed string with line spacing via a paragraph style
            // applied to the full range, preserving all existing attributes.
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
