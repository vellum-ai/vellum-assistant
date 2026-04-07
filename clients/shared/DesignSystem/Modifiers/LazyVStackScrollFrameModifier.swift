import SwiftUI

extension View {
    /// Applies an adaptive height constraint to a `ScrollView` inside a `LazyVStack` cell.
    ///
    /// For content exceeding `lineThreshold` lines, a definite `frame(height:)` is used so
    /// `LazyVStack` can skip scroll-content measurement during cell sizing. When content is a
    /// single line, the `charThreshold` catches mega-strings (e.g. base64 data, minified JSON)
    /// that would otherwise trigger an expensive Core Text width measurement — the char check
    /// is skipped for multi-line content since `lineThreshold` already covers that case.
    /// Short content gets no height constraint at all — the ScrollView collapses to its
    /// natural content height. Do NOT use `.frame(maxHeight:)` for the short path — it
    /// creates a `_FlexFrameLayout` that recursively measures children inside LazyVStack cells.
    ///
    /// - Parameters:
    ///   - text: The string whose size determines which constraint is applied.
    ///   - maxHeight: The definite height applied when content is long.
    ///   - lineThreshold: Line count above which the fixed height is used. Default: 30.
    ///   - charThreshold: Character count above which the fixed height is used. Default: 50 000.
    ///   - lineCount: Pre-computed line count. When provided, the modifier skips its
    ///     internal `countLines` scan. Use this when the caller caches the line count
    ///     via `@State` to avoid redundant O(n) work on re-render.
    func adaptiveScrollFrame(
        for text: String,
        maxHeight: CGFloat,
        lineThreshold: Int = 30,
        charThreshold: Int = 50_000,
        lineCount: Int? = nil
    ) -> some View {
        let lines = lineCount ?? countLines(in: text)
        let isLong = lines > lineThreshold || (lines == 1 && text.count > charThreshold)
        return self
            .frame(height: isLong ? maxHeight : nil)
            // Short content: no height constraint — ScrollView collapses to
            // content height naturally. Do NOT use .frame(maxHeight:) here —
            // it creates a _FlexFrameLayout that recursively measures children.
    }
}

/// Counts newlines without allocating N substrings.
/// Equivalent to `text.components(separatedBy: "\n").count` but O(1) memory.
private func countLines(in text: String) -> Int {
    var count = 1
    for byte in text.utf8 where byte == 0x0A { count += 1 }
    return count
}
