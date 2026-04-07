import SwiftUI

extension View {
    /// Applies an adaptive height constraint to a `ScrollView` inside a `LazyVStack` cell.
    ///
    /// For content exceeding `lineThreshold` lines, a definite `frame(height:)` is used so
    /// `LazyVStack` can skip scroll-content measurement during cell sizing. For shorter content
    /// `frame(maxHeight:)` is used so the view collapses to its natural height instead of
    /// rendering with blank space.
    ///
    /// - Parameters:
    ///   - text: The string whose line count determines which constraint is applied.
    ///   - maxHeight: The height cap applied in both branches.
    ///   - lineThreshold: Line count above which the fixed height is used. Default: 500.
    func adaptiveScrollFrame(
        for text: String,
        maxHeight: CGFloat,
        lineThreshold: Int = 500
    ) -> some View {
        let isLong = StringUtils.countLines(in: text) > lineThreshold
        return self
            .frame(height: isLong ? maxHeight : nil)
            .frame(maxHeight: isLong ? nil : maxHeight)
    }
}
