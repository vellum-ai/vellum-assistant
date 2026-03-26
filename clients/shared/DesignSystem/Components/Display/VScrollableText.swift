import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// A read-only, scrollable text view optimized for displaying large text content.
///
/// Uses platform-native text views (NSTextView on macOS, UITextView on iOS) which
/// handle large text efficiently through TextKit's internal layout virtualization —
/// only visible text regions are laid out and rendered, regardless of total content size.
///
/// On macOS the NSTextView renders immediately with no intermediate skeleton state.
/// On iOS, lines are split asynchronously and rendered via `LazyVStack`.
///
/// Supports an optional `maxHeight` to constrain the visible area with scrolling,
/// and provides native text selection and copy for free.
///
/// ```swift
/// // Basic usage
/// VScrollableText("Large output content here...")
///
/// // With height constraint
/// VScrollableText("Large output...", maxHeight: 400)
/// ```
public struct VScrollableText: View {
    let text: String
    let maxHeight: CGFloat?
    let font: Font
    let foregroundStyle: Color

    /// Async line-splitting state (iOS only): nil = not yet computed.
    @State private var preparedLines: [String]?

    public init(
        _ text: String,
        maxHeight: CGFloat? = nil,
        font: Font = VFont.bodySmallDefault,
        foregroundStyle: Color = VColor.contentSecondary
    ) {
        self.text = text
        self.maxHeight = maxHeight
        self.font = font
        self.foregroundStyle = foregroundStyle
    }

    public var body: some View {
        Group {
            #if os(macOS)
            macOSTextView
            #else
            if let lines = preparedLines {
                lazyContent(lines: lines)
            } else {
                placeholder
            }
            #endif
        }
        #if !os(macOS)
        .task(id: text) {
            let input = text
            let result = await Task.detached(priority: .userInitiated) {
                input.split(separator: "\n", omittingEmptySubsequences: false)
                    .map(String.init)
            }.value
            guard !Task.isCancelled else { return }
            preparedLines = result
        }
        #endif
    }

    /// Skeleton placeholder shown while lines are being split on a background thread (iOS only).
    private var placeholder: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(0..<3, id: \.self) { _ in
                VSkeletonBone()
                    .frame(height: 12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxHeight: maxHeight)
    }

    // MARK: - macOS (NSTextView)

    #if os(macOS)
    private var macOSTextView: some View {
        ScrollableNSTextView(
            text: text,
            nsFont: VFont.nsBodySmallDefault,
            foregroundStyle: foregroundStyle
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxHeight: maxHeight)
    }
    #endif

    // MARK: - iOS / Fallback (LazyVStack)

    private func lazyContent(lines: [String]) -> some View {
        ScrollView(.vertical, showsIndicators: true) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .font(font)
                        .foregroundStyle(foregroundStyle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            }
        }
        .frame(maxHeight: maxHeight)
    }
}

// MARK: - macOS NSTextView wrapper

#if os(macOS)

/// Wraps a non-editable `NSTextView` for efficient large-text display.
///
/// TextKit 1 handles layout virtualization internally — only visible text
/// regions are laid out, so performance is independent of content size.
///
/// Text is assigned asynchronously via `DispatchQueue.main.async` to avoid
/// blocking the current SwiftUI layout pass when the string is very large.
/// A lightweight hash tracks which text has been applied so that `updateNSView`
/// avoids redundant O(n) string comparisons.
private struct ScrollableNSTextView: NSViewRepresentable {
    let text: String
    let nsFont: NSFont
    let foregroundStyle: Color

    final class Coordinator {
        /// Hash of the last text applied to the NSTextView, used to skip
        /// redundant O(n) string comparisons in `updateNSView`.
        var appliedTextHash: Int = 0
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.usesFontPanel = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0

        textView.font = nsFont
        textView.textColor = NSColor(foregroundStyle)

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        // Assign text asynchronously to avoid blocking the current layout pass.
        let currentText = text
        let currentHash = currentText.hashValue
        context.coordinator.appliedTextHash = currentHash
        DispatchQueue.main.async {
            textView.string = currentText
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }

        let newHash = text.hashValue
        if context.coordinator.appliedTextHash != newHash {
            context.coordinator.appliedTextHash = newHash
            let currentText = text
            DispatchQueue.main.async {
                textView.string = currentText
            }
        }

        if textView.font != nsFont {
            textView.font = nsFont
        }
        let resolvedColor = NSColor(foregroundStyle)
        if textView.textColor != resolvedColor {
            textView.textColor = resolvedColor
        }
    }
}
#endif
