import AppKit
import os
import SwiftUI
import VellumAssistantShared

// MARK: - SelectableTextView

/// NSViewRepresentable wrapping a read-only, selectable `NSTextView` for
/// displaying rich text in chat bubbles with native text selection
/// (click-drag, Cmd+A, Shift+arrows, Cmd+C) — without the SwiftUI
/// `SelectionOverlay` overhead that causes scroll stalls in LazyVStack.
///
/// Uses TextKit 1 (NSLayoutManager) for reliable layout and sizing when
/// hosted inside SwiftUI via `sizeThatFits`.
///
/// References:
/// - [NSTextView](https://developer.apple.com/documentation/appkit/nstextview)
/// - [NSViewRepresentable](https://developer.apple.com/documentation/swiftui/nsviewrepresentable)
struct SelectableTextView: NSViewRepresentable {
    let attributedString: NSAttributedString
    let isSelectable: Bool
    let maxWidth: CGFloat?

    func makeNSView(context: Context) -> NSTextView {
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)

        let textContainer = NSTextContainer(size: NSSize(
            width: maxWidth ?? 0,
            height: CGFloat.greatestFiniteMagnitude
        ))
        textContainer.widthTracksTextView = true
        textContainer.heightTracksTextView = false
        textContainer.lineFragmentPadding = 0
        layoutManager.addTextContainer(textContainer)

        let textView = NSTextView(frame: .zero, textContainer: textContainer)
        textView.isEditable = false
        textView.isSelectable = isSelectable
        textView.delegate = context.coordinator
        textView.isRichText = true
        textView.usesFontPanel = false
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.textContainerInset = .zero

        context.coordinator.applyAttributedString(attributedString, to: textView)

        return textView
    }

    func updateNSView(_ textView: NSTextView, context: Context) {
        textView.isSelectable = isSelectable

        if context.coordinator.lastAttributedString != attributedString {
            context.coordinator.applyAttributedString(attributedString, to: textView)
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView textView: NSTextView,
        context: Context
    ) -> CGSize? {
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else { return nil }

        let width = maxWidth ?? proposal.width ?? 400
        textContainer.size = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let usedRect = layoutManager.usedRect(for: textContainer)
        return CGSize(width: width, height: usedRect.height)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var lastAttributedString: NSAttributedString?

        func applyAttributedString(_ attrStr: NSAttributedString, to textView: NSTextView) {
            lastAttributedString = attrStr
            guard let textStorage = textView.textStorage else { return }
            textStorage.setAttributedString(attrStr)
        }

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = link as? URL {
                NSWorkspace.shared.open(url)
                return true
            }
            if let string = link as? String, let url = URL(string: string) {
                NSWorkspace.shared.open(url)
                return true
            }
            return false
        }
    }
}

// MARK: - NSAttributedString Builder

extension SelectableTextView {

    /// Builds an `NSAttributedString` from parsed markdown segments using
    /// AppKit-native types (NSFont, NSColor, NSMutableParagraphStyle).
    ///
    /// Mirrors the rendering logic in `MarkdownSegmentView.buildAttributedStringUncached`
    /// but produces `NSAttributedString` for use in `NSTextView` instead of
    /// SwiftUI's `AttributedString` for `Text`.
    static func buildNSAttributedString(
        from segments: [MarkdownSegment],
        font: NSFont = VFont.nsChat,
        textColor: NSColor,
        secondaryTextColor: NSColor,
        codeTextColor: NSColor,
        codeBackgroundColor: NSColor,
        lineSpacing: CGFloat = 4
    ) -> NSAttributedString {
        os_signpost(.begin, log: PerfSignposts.log, name: "nsAttributedStringBuild")
        defer { os_signpost(.end, log: PerfSignposts.log, name: "nsAttributedStringBuild") }

        let result = NSMutableAttributedString()

        let baseParagraphStyle = NSMutableParagraphStyle()
        baseParagraphStyle.lineSpacing = lineSpacing

        let baseAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor,
            .paragraphStyle: baseParagraphStyle,
        ]

        for (index, segment) in segments.enumerated() {
            if index > 0 {
                result.append(NSAttributedString(string: "\n\n", attributes: baseAttributes))
            }

            switch segment {
            case .text(let text):
                let parsed = parseInlineMarkdown(
                    text,
                    baseFont: font,
                    textColor: textColor,
                    codeTextColor: codeTextColor,
                    codeBackgroundColor: codeBackgroundColor,
                    lineSpacing: lineSpacing
                )
                result.append(parsed)

            case .list(let items):
                for (itemIndex, item) in items.enumerated() {
                    if itemIndex > 0 {
                        result.append(NSAttributedString(string: "\n", attributes: baseAttributes))
                    }
                    let indentLevel = item.indent / 2
                    let indentString = String(repeating: "    ", count: indentLevel)
                    let prefix = item.ordered ? "\(item.number). " : "\u{2022} "
                    let prefixText = indentString + prefix

                    let prefixWidth = (prefixText as NSString).size(
                        withAttributes: [.font: font]
                    ).width

                    let listParagraphStyle = NSMutableParagraphStyle()
                    listParagraphStyle.lineSpacing = lineSpacing
                    listParagraphStyle.headIndent = prefixWidth
                    listParagraphStyle.firstLineHeadIndent = 0

                    var prefixAttrs = baseAttributes
                    prefixAttrs[.foregroundColor] = secondaryTextColor
                    prefixAttrs[.paragraphStyle] = listParagraphStyle
                    result.append(NSAttributedString(string: prefixText, attributes: prefixAttrs))

                    let itemParsed = parseInlineMarkdown(
                        item.text,
                        baseFont: font,
                        textColor: textColor,
                        codeTextColor: codeTextColor,
                        codeBackgroundColor: codeBackgroundColor,
                        lineSpacing: lineSpacing
                    )
                    let itemMutable = NSMutableAttributedString(attributedString: itemParsed)
                    itemMutable.addAttribute(
                        .paragraphStyle,
                        value: listParagraphStyle,
                        range: NSRange(location: 0, length: itemMutable.length)
                    )
                    result.append(itemMutable)
                }

            default:
                break
            }
        }

        return result
    }

    /// Parses inline markdown (bold, italic, code, links) into an
    /// `NSAttributedString` using Foundation's markdown parser, then
    /// post-processes runs to apply AppKit-native font/color attributes.
    private static func parseInlineMarkdown(
        _ text: String,
        baseFont: NSFont,
        textColor: NSColor,
        codeTextColor: NSColor,
        codeBackgroundColor: NSColor,
        lineSpacing: CGFloat
    ) -> NSAttributedString {
        let mdOptions = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let swiftAttr = (try? AttributedString(markdown: text, options: mdOptions))
            ?? AttributedString(text)

        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing

        let result = NSMutableAttributedString()

        for run in swiftAttr.runs {
            let runText = String(swiftAttr[run.range].characters)
            var attrs: [NSAttributedString.Key: Any] = [
                .font: baseFont,
                .foregroundColor: textColor,
                .paragraphStyle: paragraphStyle,
            ]

            let intent = run.inlinePresentationIntent
            let isCode = intent?.contains(.code) == true
            let isEmph = intent?.contains(.emphasized) == true
            let isBold = intent?.contains(.stronglyEmphasized) == true

            if isCode {
                attrs[.foregroundColor] = codeTextColor
                attrs[.backgroundColor] = codeBackgroundColor
            } else {
                if isEmph && isBold {
                    attrs[.font] = boldItalicFont(size: baseFont.pointSize)
                } else if isEmph {
                    attrs[.font] = italicFont(size: baseFont.pointSize)
                } else if isBold {
                    attrs[.font] = VFont.nsDMSans(weight: 700, size: baseFont.pointSize)
                }
            }

            if let link = swiftAttr[run.range].link {
                attrs[.link] = link
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }

            if isCode {
                var padAttrs = attrs
                padAttrs[.backgroundColor] = codeBackgroundColor
                result.append(NSAttributedString(string: "\u{2009}", attributes: padAttrs))
                result.append(NSAttributedString(string: runText, attributes: attrs))
                result.append(NSAttributedString(string: "\u{2009}", attributes: padAttrs))
            } else {
                result.append(NSAttributedString(string: runText, attributes: attrs))
            }
        }

        return result
    }

    // MARK: - Synthetic Italic/Bold Fonts

    /// DM Sans doesn't have an italic face. Apply a synthetic oblique
    /// via affine transform (12° skew), matching the SwiftUI version in
    /// `MarkdownSegmentView.buildAttributedStringUncached`.
    private static func italicFont(size: CGFloat) -> NSFont {
        var oblique = CGAffineTransform(
            a: 1, b: 0,
            c: CGFloat(tan(12.0 * .pi / 180.0)), d: 1,
            tx: 0, ty: 0
        )
        let ct = CTFontCreateWithName("DMSans-Regular" as CFString, size, &oblique)
        return ct as NSFont
    }

    private static func boldItalicFont(size: CGFloat) -> NSFont {
        var oblique = CGAffineTransform(
            a: 1, b: 0,
            c: CGFloat(tan(12.0 * .pi / 180.0)), d: 1,
            tx: 0, ty: 0
        )
        let wghtTag = 0x77676874
        let baseCT = CTFontCreateWithName("DMSans-Regular" as CFString, size, nil)
        let boldVars: [CFNumber: CFNumber] = [wghtTag as CFNumber: 700 as CFNumber]
        let boldItalicCT = CTFontCreateCopyWithAttributes(
            baseCT, size, &oblique,
            CTFontDescriptorCreateWithAttributes([
                kCTFontVariationAttribute: boldVars,
            ] as CFDictionary)
        )
        return boldItalicCT as NSFont
    }

    // MARK: - NSAttributedString Cache

    @MainActor private static var cache: NSCache<NSNumber, NSAttributedString> = {
        let c = NSCache<NSNumber, NSAttributedString>()
        c.countLimit = 1_000
        c.totalCostLimit = 10_000_000
        return c
    }()
    private static let maxCacheableLength = 10_000

    /// Builds (or retrieves from cache) an NSAttributedString for
    /// the given segments and style parameters.
    @MainActor
    static func cachedNSAttributedString(
        from segments: [MarkdownSegment],
        font: NSFont = VFont.nsChat,
        textColor: NSColor,
        secondaryTextColor: NSColor,
        codeTextColor: NSColor,
        codeBackgroundColor: NSColor,
        lineSpacing: CGFloat = 4
    ) -> NSAttributedString {
        var hasher = Hasher()
        for segment in segments {
            hasher.combine(segment)
        }
        hasher.combine(font.pointSize)
        hasher.combine(textColor.description)
        hasher.combine(secondaryTextColor.description)
        hasher.combine(codeTextColor.description)
        hasher.combine(codeBackgroundColor.description)
        let cacheKey = hasher.finalize() as NSNumber

        if let cached = cache.object(forKey: cacheKey) {
            return cached
        }

        let result = buildNSAttributedString(
            from: segments,
            font: font,
            textColor: textColor,
            secondaryTextColor: secondaryTextColor,
            codeTextColor: codeTextColor,
            codeBackgroundColor: codeBackgroundColor,
            lineSpacing: lineSpacing
        )

        let textLen = segments.reduce(0) { total, seg in
            switch seg {
            case .text(let t): return total + t.count
            case .list(let items): return total + items.reduce(0) { $0 + $1.text.count }
            default: return total
            }
        }
        if textLen <= maxCacheableLength {
            cache.setObject(result, forKey: cacheKey, cost: textLen * 10)
        }

        return result
    }

    /// Clears the NSAttributedString cache. Called alongside
    /// `MarkdownSegmentView.clearAttributedStringCache()` when switching
    /// conversations or archiving to reclaim memory.
    @MainActor
    static func clearCache() {
        cache.removeAllObjects()
    }
}
