import SwiftUI

extension View {
    /// Applies an adaptive height constraint to a `ScrollView` inside a `LazyVStack` cell.
    ///
    /// For content exceeding `lineThreshold` lines **or** `charThreshold` characters, a definite
    /// `frame(height:)` is used so `LazyVStack` can skip scroll-content measurement during cell
    /// sizing. The character threshold catches single-line mega-strings that would otherwise
    /// trigger an expensive width measurement pass. For shorter content `frame(maxHeight:)` is
    /// used so the view collapses to its natural height instead of rendering with blank space.
    ///
    /// - Parameters:
    ///   - text: The string whose size determines which constraint is applied.
    ///   - maxHeight: The height cap applied in both branches.
    ///   - lineThreshold: Line count above which the fixed height is used. Default: 500.
    ///   - charThreshold: Character count above which the fixed height is used. Default: 50 000.
    func adaptiveScrollFrame(
        for text: String,
        maxHeight: CGFloat,
        lineThreshold: Int = 500,
        charThreshold: Int = 50_000
    ) -> some View {
        let isLong = countLines(in: text) > lineThreshold || text.count > charThreshold
        return self
            .frame(height: isLong ? maxHeight : nil)
            .frame(maxHeight: isLong ? nil : maxHeight)
    }
}

/// Counts newlines without allocating N substrings.
/// Equivalent to `text.components(separatedBy: "\n").count` but O(1) memory.
private func countLines(in text: String) -> Int {
    var count = 1
    for byte in text.utf8 where byte == 0x0A { count += 1 }
    return count
}
