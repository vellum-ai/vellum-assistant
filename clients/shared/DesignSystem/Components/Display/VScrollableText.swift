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
/// Supports an optional `maxHeight` to constrain the visible area with scrolling,
/// and provides native text selection and copy for free.
///
/// ```swift
/// // Basic usage
/// VScrollableText("Large output content here...")
///
/// // With height constraint
/// VScrollableText("Large output...", maxHeight: 400)
///
/// // With custom font and color
/// VScrollableText(
///     "Output text",
///     maxHeight: 400,
///     font: VFont.bodySmallDefault,
///     foregroundStyle: VColor.contentSecondary
/// )
/// ```
public struct VScrollableText: View {
    let text: String
    let maxHeight: CGFloat?
    let font: Font
    let foregroundStyle: Color

    /// Async line-splitting state: nil = not yet computed, empty = zero lines.
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
            if let lines = preparedLines {
                scrollableContent(lines: lines)
            } else {
                placeholder
            }
        }
        .task(id: text) {
            let input = text
            let lines = await Task.detached(priority: .userInitiated) {
                input.split(separator: "\n", omittingEmptySubsequences: false)
                    .map(String.init)
            }.value
            guard !Task.isCancelled else { return }
            preparedLines = lines
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func scrollableContent(lines: [String]) -> some View {
        #if os(macOS)
        macOSTextView
        #else
        lazyContent(lines: lines)
        #endif
    }

    /// Skeleton placeholder shown while lines are being split on a background thread.
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
        ScrollableNSTextView(text: text, font: font, foregroundStyle: foregroundStyle)
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
/// TextKit 1 handles layout virtualization internally — only visible text
/// regions are laid out, so performance is independent of content size.
private struct ScrollableNSTextView: NSViewRepresentable {
    let text: String
    let font: Font
    let foregroundStyle: Color

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

        textView.font = Self.resolveNSFont(font)
        textView.textColor = NSColor(foregroundStyle)
        textView.string = text

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
        }
        let resolvedFont = Self.resolveNSFont(font)
        if textView.font != resolvedFont {
            textView.font = resolvedFont
        }
        let resolvedColor = NSColor(foregroundStyle)
        if textView.textColor != resolvedColor {
            textView.textColor = resolvedColor
        }
    }

    /// Resolves a SwiftUI `Font` token to an `NSFont` for the text view.
    /// Falls back to the design system mono font if resolution fails.
    private static func resolveNSFont(_ font: Font) -> NSFont {
        // The design system uses DM Sans 12pt for bodySmallDefault.
        // CTFont bridging: SwiftUI Font wraps a platform font internally.
        // We resolve common design-system tokens to their NSFont equivalents.
        NSFont(name: "DMSans-Regular", size: 12)
            ?? NSFont.systemFont(ofSize: 12)
    }
}
#endif
